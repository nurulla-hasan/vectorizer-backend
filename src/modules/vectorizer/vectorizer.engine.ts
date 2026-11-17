import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ImageTracer, { type ImageTracerOptions } from 'imagetracerjs';
import potrace from 'potrace';
import sharp from 'sharp';
import { optimize as optimizeSvg } from 'svgo';
import SVGPathCommander from 'svg-path-commander';
import { detectTwoPoleField } from './subpixel-tracer.js';
import type { VectorSettings } from './vectorizer.validation.js';

const execFileAsync = promisify(execFile);

export const SHARP_LIMIT_INPUT_PIXELS = 25_000_000;

export type VectorEngine =
  | 'ai-vtracer-native'
  | 'ai-potrace-bezier'
  | 'vtracer-native'
  | 'subpixel-bezier'
  | 'potrace-bezier'
  | 'imagetracerjs';

export interface VectorPathItem {
  id: string;
  fill: string;
  fillRule?: 'nonzero' | 'evenodd';
  d: string;
  transform?: string;
}

export interface VectorPreviewData {
  viewBox: string;
  width: number;
  height: number;
  pathCount: number;
  palette: string[];
  paths: VectorPathItem[];
  svg: string;
}

const resolveVtracerBinary = (): string => {
  if (process.env.VTRACER_PATH) {
    return process.env.VTRACER_PATH;
  }

  const localBin = path.resolve(
    process.cwd(),
    'bin',
    process.platform === 'win32' ? 'vtracer.exe' : 'vtracer',
  );
  if (fsSync.existsSync(localBin)) {
    return localBin;
  }

  return 'vtracer';
};

const resolveRealEsrganConfig = (): {
  binary: string;
  modelsDir: string;
  modelName: string;
} | null => {
  if (process.env.REALESRGAN_DISABLED === '1') {
    return null;
  }

  const binDir = path.resolve(process.cwd(), 'bin', 'realesrgan');
  const defaultExe = path.join(
    binDir,
    process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan',
  );
  const binary = process.env.REALESRGAN_PATH || defaultExe;
  if (!fsSync.existsSync(binary)) {
    return null;
  }

  const modelsDir = path.join(path.dirname(binary), 'models');
  if (!fsSync.existsSync(modelsDir)) {
    return null;
  }

  const preferred = process.env.REALESRGAN_MODEL?.trim();
  const candidates = preferred
    ? [preferred]
    : ['realesr-animevideov3-x4', 'realesrgan-x4plus-anime'];

  const modelName = candidates.find(
    (name) =>
      fsSync.existsSync(path.join(modelsDir, `${name}.param`)) &&
      fsSync.existsSync(path.join(modelsDir, `${name}.bin`)),
  );
  if (!modelName) {
    return null;
  }

  return { binary, modelsDir, modelName };
};

/**
 * Symmetric directional ridge/valley enhancement on 4x upscaled RGBA pixels.
 * Pushes bright valleys trapped between two opposing dark strokes toward open white
 * without disturbing open edges or closing narrow V-crevices.
 */
const enhanceLocalCrevices = (
  rgba: Buffer,
  width: number,
  height: number,
  radius = 4,
): Buffer => {
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    lum[p] = (0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0)) / 255;
  }

  const out = Buffer.from(rgba);
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [radius, 0],
    [0, radius],
    [radius, radius],
    [radius, -radius],
  ];

  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const p = y * width + x;
      const idx = p * 4;
      if ((rgba[idx + 3] ?? 0) < 128) continue;

      const c = lum[p]!;
      if (c <= 0.08 || c >= 0.92) continue;

      let bestRidge = 0;
      let bestValley = 0;
      for (const [dx, dy] of dirs) {
        const a = lum[(y - dy) * width + (x - dx)]!;
        const b = lum[(y + dy) * width + (x + dx)]!;
        const wingMax = Math.max(a, b);
        const wingMin = Math.min(a, b);
        if (c > wingMax) {
          bestRidge = Math.max(bestRidge, c - wingMax);
        }
        if (c < wingMin) {
          bestValley = Math.max(bestValley, wingMin - c);
        }
      }

      const delta = Math.round((bestRidge * 0.45 - bestValley * 0.35) * 255);
      if (delta === 0) continue;

      out[idx] = Math.max(0, Math.min(255, (rgba[idx] ?? 0) + delta));
      out[idx + 1] = Math.max(0, Math.min(255, (rgba[idx + 1] ?? 0) + delta));
      out[idx + 2] = Math.max(0, Math.min(255, (rgba[idx + 2] ?? 0) + delta));
    }
  }

  return out;
};

const reconstructUpscaledGeometry = async (
  originalPath: string,
  tempAiPath: string,
  origWidth: number,
  origHeight: number,
  factor: 1 | 2 | 4,
): Promise<{
  data: Buffer;
  width: number;
  height: number;
  usedAi: boolean;
}> => {
  if (factor === 1) {
    const { data, info } = await sharp(originalPath, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, usedAi: false };
  }

  // 2x is a plain denoising resample used by the multi-color vtracer path: JPEG block
  // noise along boundaries is what makes traced corners bulge, so avoid sharpening here.
  if (factor === 2) {
    const { data, info } = await sharp(originalPath, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .resize(origWidth * 2, origHeight * 2, { kernel: sharp.kernel.lanczos3 })
      .median(3)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, usedAi: false };
  }

  const aiConfig = resolveRealEsrganConfig();
  if (aiConfig) {
    try {
      await execFileAsync(
        aiConfig.binary,
        [
          '-i',
          originalPath,
          '-o',
          tempAiPath,
          '-n',
          aiConfig.modelName,
          '-s',
          '4',
          '-t',
          '640',
          '-m',
          aiConfig.modelsDir,
        ],
        { timeout: 25_000 },
      );

      const { data, info } = await sharp(tempAiPath, {
        limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
      })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (info.width === origWidth * 4 && info.height === origHeight * 4) {
        return { data, width: info.width, height: info.height, usedAi: true };
      }
    } catch (error) {
      console.warn(
        '[Vectorizer] Real-ESRGAN AI 4x unavailable/failed, using CPU sharpen + ridge enhancement:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const { data, info } = await sharp(originalPath, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
  })
    .resize(origWidth * 4, origHeight * 4, { kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 1.4, m1: 3.0, m2: 6.0 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: enhanceLocalCrevices(data, info.width, info.height, 4),
    width: info.width,
    height: info.height,
    usedAi: false,
  };
};

const rgbToHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

const colorDistSq = (
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number => (r1 - r2) * (r1 - r2) + (g1 - g2) * (g1 - g2) + (b1 - b2) * (b1 - b2);

/**
 * vtracer's internal color clustering emits a ramp of near-duplicate fills along every
 * boundary (e.g. #173D7B, #183E7C, #1A407E) even when the traced raster contains only
 * the snapped palette. Those sliver layers double every contour and make corners look
 * ragged, so map each emitted fill back onto the palette the raster was snapped to.
 */
const snapSvgFillsToPalette = (
  svg: string,
  palette: ReadonlyArray<readonly [number, number, number]>,
): string => {
  if (palette.length === 0) return svg;

  const resolveFill = (fill: string): string => {
    const match = fill.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return fill;
    const hex =
      match[1]!.length === 3
        ? match[1]!
            .split('')
            .map((c) => c + c)
            .join('')
        : match[1]!;
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);

    let best = palette[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const cand of palette) {
      const dist = colorDistSq(r, g, b, cand[0], cand[1], cand[2]);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
    return rgbToHex(best);
  };

  return svg.replace(/fill="(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))"/g, (_m, fill: string) => {
    return `fill="${resolveFill(fill)}"`;
  });
};

/**
 * Extract up to `maxColors` dominant solid RGB colors strictly from interior flat pixels
 * (pixels whose 4 immediate cardinal neighbors are within Euclidean RGB distance < 18),
 * eliminating anti-aliased edge gradient halos before clustering and color snapping.
 */
const extractInteriorPalette = (
  rgba: Buffer,
  width: number,
  height: number,
  maxColors: number,
): Array<[number, number, number]> => {
  const flatSamples: Array<[number, number, number]> = [];
  const allOpaqueSamples: Array<[number, number, number]> = [];
  const edgeLimitSq = 18 * 18;
  const stride = width * height > 800_000 ? 2 : 1;

  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const idx = (y * width + x) * 4;
      const a = rgba[idx + 3] ?? 0;
      if (a < 128) continue;

      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      allOpaqueSamples.push([r, g, b]);

      const neighbors = [idx - width * 4, idx + width * 4, idx - 4, idx + 4];
      let isFlat = true;

      for (const nIdx of neighbors) {
        if ((rgba[nIdx + 3] ?? 0) < 128) {
          isFlat = false;
          break;
        }
        const nr = rgba[nIdx] ?? 0;
        const ng = rgba[nIdx + 1] ?? 0;
        const nb = rgba[nIdx + 2] ?? 0;
        if (colorDistSq(r, g, b, nr, ng, nb) >= edgeLimitSq) {
          isFlat = false;
          break;
        }
      }

      if (isFlat) {
        flatSamples.push([r, g, b]);
      }
    }
  }

  // Fallback for ultra-thin 1px line art / tiny icons with almost no interior flat area
  const poolSamples = flatSamples.length >= 16 ? flatSamples : allOpaqueSamples;
  if (poolSamples.length === 0) return [];

  const buckets = new Map<
    number,
    { count: number; sr: number; sg: number; sb: number }
  >();
  for (const [r, g, b] of poolSamples) {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const entry = buckets.get(key) ?? { count: 0, sr: 0, sg: 0, sb: 0 };
    entry.count++;
    entry.sr += r;
    entry.sg += g;
    entry.sb += b;
    buckets.set(key, entry);
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const minClusterCount = Math.max(2, Math.floor(poolSamples.length * 0.002));
  const significant = sorted.filter((b) => b.count >= minClusterCount);
  const pool = significant.length >= 2 ? significant : sorted;

  const mergeDistSq = 42 * 42;
  const clusters: Array<{
    count: number;
    sr: number;
    sg: number;
    sb: number;
    r: number;
    g: number;
    b: number;
  }> = [];

  for (const b of pool) {
    const cr = Math.round(b.sr / b.count);
    const cg = Math.round(b.sg / b.count);
    const cb = Math.round(b.sb / b.count);

    let merged = false;
    for (const existing of clusters) {
      if (colorDistSq(cr, cg, cb, existing.r, existing.g, existing.b) < mergeDistSq) {
        existing.count += b.count;
        existing.sr += b.sr;
        existing.sg += b.sg;
        existing.sb += b.sb;
        existing.r = Math.round(existing.sr / existing.count);
        existing.g = Math.round(existing.sg / existing.count);
        existing.b = Math.round(existing.sb / existing.count);
        merged = true;
        break;
      }
    }

    if (!merged && clusters.length < maxColors) {
      clusters.push({ ...b, r: cr, g: cg, b: cb });
    }
  }

  return clusters.map((c) => [c.r, c.g, c.b]);
};

const runPotraceTrace = (
  inputBuffer: Buffer,
  options: potrace.PotraceOptions,
): Promise<string> =>
  new Promise((resolve, reject) => {
    potrace.trace(inputBuffer, options, (err, svg) => {
      if (err) return reject(err);
      resolve(svg);
    });
  });

/**
 * Trace 1- or 2-color artwork with Potrace using a continuous grayscale coverage mask
 * from the 4x Lanczos3 + blur(0.45) upscaled buffer so `threshold: 140` keeps narrow
 * white crevices open and `alphaMax: 0.9` + `optTolerance: 0.12` preserves sharp cusps.
 */
const traceWithPotraceContinuous = async (
  upscaledRaw: Buffer,
  traceWidth: number,
  traceHeight: number,
  fgRgb: readonly [number, number, number],
  bgRgb: readonly [number, number, number] | null,
  settings: VectorSettings,
): Promise<string> => {
  const fgHex = rgbToHex(fgRgb);
  const maskRgba = Buffer.allocUnsafe(traceWidth * traceHeight * 4);

  if (!bgRgb) {
    // Transparent background: map alpha continuously [0..255] -> [255..0]
    for (let i = 0; i < upscaledRaw.length; i += 4) {
      const a = upscaledRaw[i + 3] ?? 0;
      const v = 255 - a;
      maskRgba[i] = v;
      maskRgba[i + 1] = v;
      maskRgba[i + 2] = v;
      maskRgba[i + 3] = 255;
    }
  } else {
    const vx = fgRgb[0] - bgRgb[0];
    const vy = fgRgb[1] - bgRgb[1];
    const vz = fgRgb[2] - bgRgb[2];
    const vLenSq = vx * vx + vy * vy + vz * vz || 1;

    for (let i = 0; i < upscaledRaw.length; i += 4) {
      const a = upscaledRaw[i + 3] ?? 0;
      if (a < 16) {
        maskRgba[i] = 255;
        maskRgba[i + 1] = 255;
        maskRgba[i + 2] = 255;
        maskRgba[i + 3] = 255;
        continue;
      }

      const r = upscaledRaw[i] ?? 0;
      const g = upscaledRaw[i + 1] ?? 0;
      const b = upscaledRaw[i + 2] ?? 0;
      const tRaw = ((r - bgRgb[0]) * vx + (g - bgRgb[1]) * vy + (b - bgRgb[2]) * vz) / vLenSq;
      const t = Math.max(0, Math.min(1, tRaw));
      const v = Math.round(255 * (1 - t));
      maskRgba[i] = v;
      maskRgba[i + 1] = v;
      maskRgba[i + 2] = v;
      maskRgba[i + 3] = 255;
    }
  }

  const maskPng = await sharp(maskRgba, {
    raw: { width: traceWidth, height: traceHeight, channels: 4 },
  })
    .png()
    .toBuffer();

  const tracedSvg = await runPotraceTrace(maskPng, {
    threshold: 148,
    alphaMax: 0.85,
    optCurve: true,
    optTolerance: 0.1,
    turdSize: Math.max(2, settings.filterSpeckle * 2),
    blackOnWhite: true,
    color: fgHex,
    background: 'transparent',
  });

  if (!bgRgb) {
    return tracedSvg;
  }

  const bgHex = rgbToHex(bgRgb);
  const bgPath = `<path d="M0 0H${traceWidth}V${traceHeight}H0Z" fill="${bgHex}"/>`;
  return tracedSvg.replace(/<svg\b([^>]*)>/i, `<svg$1>${bgPath}`);
};

const determineForegroundBackground = (
  raw: Buffer,
  width: number,
  height: number,
  c0: readonly [number, number, number],
  c1: readonly [number, number, number],
): { fgRgb: readonly [number, number, number]; bgRgb: readonly [number, number, number] } => {
  const borderCounts = [0, 0];
  const totalCounts = [0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if ((raw[idx + 3] ?? 0) < 128) continue;

      const r = raw[idx] ?? 0;
      const g = raw[idx + 1] ?? 0;
      const b = raw[idx + 2] ?? 0;
      const d0 = colorDistSq(r, g, b, c0[0], c0[1], c0[2]);
      const d1 = colorDistSq(r, g, b, c1[0], c1[1], c1[2]);
      const idxMatch = d0 <= d1 ? 0 : 1;

      totalCounts[idxMatch]!++;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        borderCounts[idxMatch]!++;
      }
    }
  }

  const bgIndex =
    borderCounts[0]! !== borderCounts[1]!
      ? borderCounts[0]! > borderCounts[1]!
        ? 0
        : 1
      : totalCounts[0]! >= totalCounts[1]!
        ? 0
        : 1;
  return bgIndex === 0 ? { bgRgb: c0, fgRgb: c1 } : { bgRgb: c1, fgRgb: c0 };
};

/**
 * Primary AI-assisted vectorization pipeline:
 * 1) Extract interior-only / 2-pole palette cleanly (using median only on palette sample when filterSpeckle > 12).
 * 2) Reconstruct 4x geometry via local Real-ESRGAN (`realesrgan-ncnn-vulkan`) or CPU sharpen + ridge enhancement fallback.
 * 3) Route 1-/2-color artwork to Potrace (`threshold: 148, alphaMax: 0.85, optTolerance: 0.1`) and multi-color
 *    artwork to native Rust vtracer (`--corner_threshold 55 --segment_length 4.5 --splice_threshold 45 --path_precision 4`).
 */
const tryPrimaryVectorizer = async (
  originalPath: string,
  outputPath: string,
  settings: VectorSettings,
  origWidth: number,
  origHeight: number,
): Promise<{
  success: boolean;
  engine: VectorEngine;
  traceWidth: number;
  traceHeight: number;
  scaleFactor: number;
}> => {
  const binary = resolveVtracerBinary();
  const targetColors = Math.max(2, Math.min(64, settings.maxColors));
  const longestSide = Math.max(origWidth, origHeight);
  const pixelMode = settings.mode === 'pixel';
  const tempAiPath = path.join(path.dirname(originalPath), 'ai_4x.png');
  const tempInputPath = path.join(path.dirname(originalPath), 'vtracer-snapped.png');

  try {
    const { data: origRaw, info: origInfo } = await sharp(originalPath, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Optional median only for palette sampling when filterSpeckle > 12 (never on traced geometry!)
    let paletteRaw = origRaw;
    let paletteWidth = origInfo.width;
    let paletteHeight = origInfo.height;
    if (settings.filterSpeckle > 12) {
      const sampled = await sharp(originalPath, {
        limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
      })
        .median(3)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      paletteRaw = sampled.data;
      paletteWidth = sampled.info.width;
      paletteHeight = sampled.info.height;
    }

    const twoPole =
      !pixelMode
        ? detectTwoPoleField(origRaw, origInfo.width, origInfo.height, settings.colorPrecision) ??
          (paletteRaw !== origRaw
            ? detectTwoPoleField(paletteRaw, paletteWidth, paletteHeight, settings.colorPrecision)
            : null)
        : null;

    // Multi-color art at the service cap traces from a 2x denoised source: tracing 1x
    // JPEG edges is what produces the lumpy, uneven key-cap corners.
    const scaleFactor: 1 | 2 | 4 = pixelMode
      ? 1
      : longestSide < 1200
        ? 4
        : !twoPole && longestSide <= 2048
          ? 2
          : 1;

    const palette = twoPole
      ? twoPole.hasTransparentBg
        ? [twoPole.fgRgb]
        : [twoPole.bgRgb, twoPole.fgRgb]
      : extractInteriorPalette(paletteRaw, paletteWidth, paletteHeight, targetColors);

    // 4x AI super-resolution (or CPU Lanczos3 + deblur sharpen + local crevice ridge enhancement fallback)
    const {
      data: upscaledRaw,
      width: upscaledWidth,
      height: upscaledHeight,
      usedAi,
    } = await reconstructUpscaledGeometry(originalPath, tempAiPath, origWidth, origHeight, scaleFactor);
    const upscaledInfo = { width: upscaledWidth, height: upscaledHeight };

    if (twoPole) {
      const potraceSvg = await traceWithPotraceContinuous(
        upscaledRaw,
        upscaledInfo.width,
        upscaledInfo.height,
        twoPole.fgRgb,
        twoPole.hasTransparentBg ? null : twoPole.bgRgb,
        settings,
      );
      await fs.writeFile(outputPath, potraceSvg, 'utf8');
      return {
        success: true,
        engine: usedAi ? 'ai-potrace-bezier' : 'potrace-bezier',
        traceWidth: upscaledInfo.width,
        traceHeight: upscaledInfo.height,
        scaleFactor,
      };
    }

    let transparentPixels = 0;
    for (let i = 0; i < upscaledRaw.length; i += 4) {
      if ((upscaledRaw[i + 3] ?? 0) < 128) transparentPixels++;
    }
    const totalUpscaledPixels = upscaledInfo.width * upscaledInfo.height;
    const hasSignificantTransparency = transparentPixels > totalUpscaledPixels * 0.01;

    if (
      palette.length > 0 &&
      (palette.length === 1 || (palette.length === 2 && !hasSignificantTransparency))
    ) {
      const pair =
        palette.length === 2
          ? determineForegroundBackground(
              upscaledRaw,
              upscaledInfo.width,
              upscaledInfo.height,
              palette[0]!,
              palette[1]!,
            )
          : { fgRgb: palette[0]!, bgRgb: null };
      const potraceSvg = await traceWithPotraceContinuous(
        upscaledRaw,
        upscaledInfo.width,
        upscaledInfo.height,
        pair.fgRgb,
        pair.bgRgb,
        settings,
      );
      await fs.writeFile(outputPath, potraceSvg, 'utf8');
      return {
        success: true,
        engine: usedAi ? 'ai-potrace-bezier' : 'potrace-bezier',
        traceWidth: upscaledInfo.width,
        traceHeight: upscaledInfo.height,
        scaleFactor,
      };
    }

    // Snap multi-color 4x geometry image strictly to interior palette for vtracer
    if (palette.length > 0) {
      for (let i = 0; i < upscaledRaw.length; i += 4) {
        const a = upscaledRaw[i + 3] ?? 0;
        if (a < 128) {
          upscaledRaw[i] = 0;
          upscaledRaw[i + 1] = 0;
          upscaledRaw[i + 2] = 0;
          upscaledRaw[i + 3] = 0;
          continue;
        }

        const r = upscaledRaw[i] ?? 0;
        const g = upscaledRaw[i + 1] ?? 0;
        const b = upscaledRaw[i + 2] ?? 0;

        let best = palette[0]!;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let p = 0; p < palette.length; p++) {
          const cand = palette[p]!;
          const dist = colorDistSq(r, g, b, cand[0], cand[1], cand[2]);
          if (dist < bestDist) {
            bestDist = dist;
            best = cand;
          }
        }

        upscaledRaw[i] = best[0];
        upscaledRaw[i + 1] = best[1];
        upscaledRaw[i + 2] = best[2];
        upscaledRaw[i + 3] = 255;
      }
    }

    await sharp(upscaledRaw, {
      raw: {
        width: upscaledInfo.width,
        height: upscaledInfo.height,
        channels: 4,
      },
    })
      .png()
      .toFile(tempInputPath);

    // filter_speckle is in trace pixels; normalize by the upscale factor so thin strokes
    // are not erased when the trace resolution doubles (12 -> 3 at 2x, not 16).
    const scaledFilterSpeckle = Math.max(
      1,
      Math.min(16, Math.round((settings.filterSpeckle * scaleFactor * scaleFactor) / 16)),
    );

    await execFileAsync(
      binary,
      [
        '--input',
        tempInputPath,
        '--output',
        outputPath,
        '--colormode',
        'color',
        '--hierarchical',
        settings.hierarchical,
        '--mode',
        settings.mode,
        '--filter_speckle',
        String(scaledFilterSpeckle),
        '--color_precision',
        '8',
        '--gradient_step',
        '0',
        '--corner_threshold',
        '55',
        '--segment_length',
        '4.5',
        '--splice_threshold',
        '45',
        '--path_precision',
        '4',
      ],
      { timeout: 30_000 },
    );

    if (palette.length > 0) {
      const tracedSvg = await fs.readFile(outputPath, 'utf8');
      await fs.writeFile(outputPath, snapSvgFillsToPalette(tracedSvg, palette), 'utf8');
    }

    return {
      success: true,
      engine: usedAi ? 'ai-vtracer-native' : 'vtracer-native',
      traceWidth: upscaledInfo.width,
      traceHeight: upscaledInfo.height,
      scaleFactor,
    };
  } catch (error) {
    console.warn(
      `[Vectorizer] Primary vectorizer failed (${binary}), falling back to imagetracerjs:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      engine: 'imagetracerjs',
      traceWidth: origWidth,
      traceHeight: origHeight,
      scaleFactor: 1,
    };
  } finally {
    await Promise.all([
      fs.rm(tempInputPath, { force: true }).catch(() => undefined),
      fs.rm(tempAiPath, { force: true }).catch(() => undefined),
    ]);
  }
};

const buildImageTracerOptions = (settings: VectorSettings): ImageTracerOptions => {
  const precisionRatio = settings.colorPrecision / 8;
  const numberofcolors = Math.max(
    2,
    Math.min(settings.maxColors, Math.round(2 + (settings.maxColors - 2) * precisionRatio)),
  );

  const rightangleenhance = settings.cornerThreshold <= 90;
  const cornerScale = Math.max(0.25, settings.cornerThreshold / 60);

  const base: ImageTracerOptions = {
    colorsampling: 2,
    numberofcolors,
    mincolorratio: 0,
    colorquantcycles: 3,
    layering: settings.hierarchical === 'cutout' ? 0 : 1,
    pathomit: settings.filterSpeckle,
    rightangleenhance,
    strokewidth: 0,
    scale: 1,
    viewbox: true,
    desc: false,
    blurradius: settings.filterSpeckle >= 8 ? 1 : 0,
    blurdelta: 20,
  };

  if (settings.mode === 'pixel') {
    return {
      ...base,
      ltres: 0.01,
      qtres: 0.01,
      linefilter: false,
      roundcoords: 0,
      pathomit: 0,
      blurradius: 0,
    };
  }

  if (settings.mode === 'polygon') {
    return {
      ...base,
      ltres: 0.5 * cornerScale,
      qtres: 1000,
      linefilter: true,
      roundcoords: 2,
    };
  }

  return {
    ...base,
    ltres: 0.8 * cornerScale,
    qtres: 0.8 * cornerScale,
    linefilter: false,
    roundcoords: 2,
  };
};

const traceWithPotracePosterizer = (
  inputBuffer: Buffer,
  settings: VectorSettings,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const steps = Math.max(2, Math.min(8, settings.maxColors));
    potrace.posterize(
      inputBuffer,
      {
        steps,
        turdSize: Math.max(2, settings.filterSpeckle),
        alphaMax: Math.min(1.333, Math.max(0, settings.cornerThreshold / 90)),
        optCurve: settings.mode === 'spline',
        optTolerance: 0.2,
      },
      (err, svg) => {
        if (err) return reject(err);
        resolve(svg);
      },
    );
  });

/**
 * Rescale 4x traced paths cleanly back to 1x original image coordinates (`scale(1 / scaleFactor)`),
 * folding any `<path transform="translate(...)">` before scaling (vtracer emits these for
 * multi-color paths), and preserve `floatPrecision: 3` without pruning tight cusp segments.
 */
const simplifyPathD = (
  d: string,
  scaleFactor = 1,
  preTranslateX = 0,
  preTranslateY = 0,
): string => {
  try {
    let commander = new SVGPathCommander(d);
    if (preTranslateX !== 0 || preTranslateY !== 0) {
      commander = commander.transform({
        translate: [preTranslateX, preTranslateY],
      });
    }
    if (scaleFactor !== 1) {
      commander = commander.transform({ scale: [1 / scaleFactor, 1 / scaleFactor] });
    }
    const abs = SVGPathCommander.pathToAbsolute(commander.toString());
    const optimized = SVGPathCommander.optimizePath(abs);
    const rounded = SVGPathCommander.roundPath(optimized, 3);
    return SVGPathCommander.pathToString(rounded);
  } catch {
    return d;
  }
};

const optimizeVectorSvg = (
  rawSvg: string,
  displayWidth: number,
  displayHeight: number,
  scaleFactor = 1,
): string => {
  const fullCanvasRectPrefix = `M0 0H${displayWidth * scaleFactor}V${displayHeight * scaleFactor}H0Z`;
  const scaledRaw = rawSvg.replace(
    /<path\b([^>]*?)\/?>/gi,
    (_full, rawAttrs: string) => {
      const dMatch = rawAttrs.match(/\bd="([^"]+)"/i);
      if (!dMatch?.[1]) return _full;

      const origD = dMatch[1];
      const trMatch = rawAttrs.match(
        /\btransform="translate\(([^,)]+),([^)]+)\)"/i,
      );
      const tx = trMatch ? Number.parseFloat(trMatch[1] ?? '0') || 0 : 0;
      const ty = trMatch ? Number.parseFloat(trMatch[2] ?? '0') || 0 : 0;
      const isFullBgRect =
        origD === fullCanvasRectPrefix ||
        (scaleFactor > 1 &&
          /^M\s*0[\s,]+0\s+H\s*\d+\s+V\s*\d+\s+H\s*0\s*Z$/i.test(origD.trim()) &&
          tx === 0 &&
          ty === 0);
      const nextD = isFullBgRect
        ? `M0 0H${displayWidth}V${displayHeight}H0Z`
        : simplifyPathD(origD, scaleFactor, tx, ty);

      const cleanedAttrs = rawAttrs
        .replace(/\s*\btransform="[^"]*"/i, '')
        .replace(/\bd="[^"]+"/i, `d="${nextD}"`);
      return `<path${cleanedAttrs}/>`;
    },
  );

  // Set normalized viewBox in original 1x display dimensions after scaling path coordinates
  const withViewBox = /\bviewBox=/i.test(scaledRaw)
    ? scaledRaw.replace(/\bviewBox=["'][^"']*["']/i, `viewBox="0 0 ${displayWidth} ${displayHeight}"`)
    : scaledRaw.replace(/<svg\b/, `<svg viewBox="0 0 ${displayWidth} ${displayHeight}"`);

  const result = optimizeSvg(withViewBox, {
    multipass: true,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            cleanupIds: false,
            convertColors: {
              names2hex: true,
              rgb2hex: true,
              shorthex: false,
              shortname: false,
            },
            convertPathData: {
              floatPrecision: 3,
            },
          },
        },
      },
    ],
  });

  return result.data.replace(/<svg\b([^>]*)>/, (_full, attrs: string) => {
    const cleaned = attrs
      .replace(/\s*\bwidth=["'][^"']*["']/gi, '')
      .replace(/\s*\bheight=["'][^"']*["']/gi, '');
    const hasVb = /\bviewBox=/.test(cleaned);
    const vbAttr = hasVb ? '' : ` viewBox="0 0 ${displayWidth} ${displayHeight}"`;
    return `<svg${cleaned}${vbAttr} width="${displayWidth}" height="${displayHeight}">`;
  });
};

const traceAndOptimizeSvg = async (
  inputPath: string,
  outputPath: string,
  settings: VectorSettings,
): Promise<void> => {
  const { data, info } = await sharp(inputPath, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const options = buildImageTracerOptions(settings);
  let rawSvg = ImageTracer.imagedataToSVG(
    {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    },
    options,
  );

  if (!/<path\b/i.test(rawSvg)) {
    const pngBuffer = await sharp(inputPath).png().toBuffer();
    rawSvg = await traceWithPotracePosterizer(pngBuffer, settings);
  }

  const optimizedSvg = optimizeVectorSvg(rawSvg, info.width, info.height, 1);
  await fs.writeFile(outputPath, optimizedSvg, 'utf8');
};

export const runVectorization = async (
  jobId: string,
  originalPath: string,
  svgPath: string,
  settings: VectorSettings,
): Promise<{ processingMs: number; engine: VectorEngine }> => {
  const start = performance.now();
  const meta = await sharp(originalPath, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
  }).metadata();
  const origWidth = meta.width || 1;
  const origHeight = meta.height || 1;

  const primaryRes = await tryPrimaryVectorizer(
    originalPath,
    svgPath,
    settings,
    origWidth,
    origHeight,
  );
  let engine: VectorEngine = 'imagetracerjs';

  if (primaryRes.success) {
    engine = primaryRes.engine;
    const rawSvg = await fs.readFile(svgPath, 'utf8');
    const optimized = optimizeVectorSvg(
      rawSvg,
      origWidth,
      origHeight,
      primaryRes.scaleFactor,
    );
    await fs.writeFile(svgPath, optimized, 'utf8');
  } else {
    await traceAndOptimizeSvg(originalPath, svgPath, settings);
  }

  const processingMs = Math.max(1, Math.round(performance.now() - start));
  await fs.writeFile(path.join(path.dirname(svgPath), 'engine.txt'), engine, 'utf8');
  console.info(`[Vectorizer] job=${jobId} engine=${engine} processingMs=${processingMs}`);

  return { processingMs, engine };
};

export const readStoredEngine = async (svgPath: string): Promise<VectorEngine> => {
  try {
    const val = (await fs.readFile(path.join(path.dirname(svgPath), 'engine.txt'), 'utf8')).trim();
    if (
      val === 'ai-vtracer-native' ||
      val === 'ai-potrace-bezier' ||
      val === 'vtracer-native' ||
      val === 'subpixel-bezier' ||
      val === 'potrace-bezier' ||
      val === 'imagetracerjs'
    ) {
      return val;
    }
  } catch {
    // Default if engine metadata file is absent
  }
  return 'imagetracerjs';
};

const normalizeHexColor = (rawFill: string): string => {
  const trimmed = rawFill.trim();
  const shortHex = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortHex) {
    return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`.toUpperCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
};

export const parseSvgPreview = (
  svg: string,
  width: number,
  height: number,
): VectorPreviewData => {
  const paths: VectorPathItem[] = [];
  const paletteSet = new Set<string>();

  const vbMatch = svg.match(/<svg\b[^>]*\bviewBox=["']([^"']+)["']/i);
  const viewBox = vbMatch?.[1] || `0 0 ${width} ${height}`;

  const pathRegex = /<path\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pathRegex.exec(svg)) !== null) {
    const attrs = match[1] ?? '';
    const dMatch = attrs.match(/\bd=["']([^"']+)["']/i);
    const fillMatch = attrs.match(/\bfill=["']([^"']+)["']/i);
    const fillRuleMatch = attrs.match(/\bfill-rule=["']([^"']+)["']/i);
    const transformMatch = attrs.match(/\btransform=["']([^"']+)["']/i);
    if (!dMatch?.[1]) continue;

    const rawFill = fillMatch?.[1] || '#000000';
    const fill = rawFill === 'none' ? 'none' : normalizeHexColor(rawFill);
    if (fill !== 'none') paletteSet.add(fill);

    const rawFillRule = fillRuleMatch?.[1]?.toLowerCase();
    const fillRule =
      rawFillRule === 'evenodd' || rawFillRule === 'nonzero'
        ? rawFillRule
        : undefined;

    paths.push({
      id: `p_${idx++}`,
      fill,
      ...(fillRule ? { fillRule } : {}),
      d: dMatch[1],
      ...(transformMatch?.[1] ? { transform: transformMatch[1] } : {}),
    });
  }

  return {
    viewBox,
    width,
    height,
    pathCount: paths.length,
    palette: [...paletteSet],
    paths,
    svg,
  };
};
