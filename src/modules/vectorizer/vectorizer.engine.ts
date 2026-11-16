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
import {
  detectTwoPoleField,
  traceSubpixelTwoPoleSvg,
} from './subpixel-tracer.js';
import type { VectorSettings } from './vectorizer.validation.js';

const execFileAsync = promisify(execFile);

export const SHARP_LIMIT_INPUT_PIXELS = 25_000_000;

export type VectorEngine =
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
 * Trace 1- or 2-color artwork directly with Potrace cubic Bezier curves.
 * Determines background vs foreground from border pixels so both light-on-dark and
 * dark-on-light drawings trace with zero anti-aliased concentric gray rings.
 */
const traceWithPotraceDualColor = async (
  snappedRaw: Buffer,
  traceWidth: number,
  traceHeight: number,
  palette: Array<[number, number, number]>,
  settings: VectorSettings,
  scaleFactor: number,
): Promise<string> => {
  let bgIndex = -1;
  let fgIndex = 0;

  if (palette.length === 2) {
    const c0 = palette[0]!;
    const borderCounts = [0, 0];
    const totalCounts = [0, 0];

    for (let y = 0; y < traceHeight; y++) {
      for (let x = 0; x < traceWidth; x++) {
        const idx = (y * traceWidth + x) * 4;
        if ((snappedRaw[idx + 3] ?? 0) < 128) continue;

        const r = snappedRaw[idx] ?? 0;
        const g = snappedRaw[idx + 1] ?? 0;
        const b = snappedRaw[idx + 2] ?? 0;
        const idxMatch = r === c0[0] && g === c0[1] && b === c0[2] ? 0 : 1;

        totalCounts[idxMatch]!++;
        if (x === 0 || x === traceWidth - 1 || y === 0 || y === traceHeight - 1) {
          borderCounts[idxMatch]!++;
        }
      }
    }

    bgIndex =
      borderCounts[0]! !== borderCounts[1]!
        ? borderCounts[0]! > borderCounts[1]!
          ? 0
          : 1
        : totalCounts[0]! >= totalCounts[1]!
          ? 0
          : 1;
    fgIndex = bgIndex === 0 ? 1 : 0;
  }

  const fgColor = palette[fgIndex]!;
  const fgHex = rgbToHex(fgColor);

  const maskRgba = Buffer.allocUnsafe(traceWidth * traceHeight * 4);
  for (let i = 0; i < snappedRaw.length; i += 4) {
    const a = snappedRaw[i + 3] ?? 0;
    const isFg =
      a >= 128 &&
      snappedRaw[i] === fgColor[0] &&
      snappedRaw[i + 1] === fgColor[1] &&
      snappedRaw[i + 2] === fgColor[2];

    const v = isFg ? 0 : 255;
    maskRgba[i] = v;
    maskRgba[i + 1] = v;
    maskRgba[i + 2] = v;
    maskRgba[i + 3] = 255;
  }

  const maskPng = await sharp(maskRgba, {
    raw: { width: traceWidth, height: traceHeight, channels: 4 },
  })
    .png()
    .toBuffer();

  const tracedSvg = await runPotraceTrace(maskPng, {
    alphaMax: 1.25,
    optCurve: true,
    optTolerance: 0.45,
    turdSize: Math.max(0, Math.round(settings.filterSpeckle * scaleFactor)),
    blackOnWhite: true,
    color: fgHex,
    background: 'transparent',
  });

  if (bgIndex === -1) {
    return tracedSvg;
  }

  const bgHex = rgbToHex(palette[bgIndex]!);
  const bgPath = `<path d="M0 0H${traceWidth}V${traceHeight}H0Z" fill="${bgHex}"/>`;
  return tracedSvg.replace(/<svg\b([^>]*)>/i, `<svg$1>${bgPath}`);
};

/**
 * Primary dual-engine vectorization pipeline:
 * 1) Inspect raw RGBA interior flat pixels only and cluster/merge into a halo-free palette.
 * 2) Upscale (<1200px) by 4x via Lanczos3 + blur(1.8) for smooth sub-pixel iso-contours.
 * 3) Snap every opaque pixel strictly to the nearest interior palette color.
 * 4) Route <= 2 opaque colors to Potrace cubic Beziers; route > 2 colors to native Rust vtracer.
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
  const shouldUpscale = Math.max(origWidth, origHeight) < 1200;
  const scaleFactor = shouldUpscale ? 4 : 1;
  const traceWidth = origWidth * scaleFactor;
  const traceHeight = origHeight * scaleFactor;
  const tempInputPath = path.join(path.dirname(originalPath), 'vtracer-snapped.png');

  try {
    const { data: origRaw, info: origInfo } = await sharp(originalPath, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Step 1A: Sub-pixel iso-contour + corner-sharpened Schneider Bezier tracer for 2-pole/monochrome art
    const twoPole =
      settings.mode !== 'pixel'
        ? detectTwoPoleField(
            origRaw,
            origInfo.width,
            origInfo.height,
            settings.colorPrecision,
          )
        : null;

    if (twoPole) {
      const subpixelSvg = traceSubpixelTwoPoleSvg(
        twoPole,
        origInfo.width,
        origInfo.height,
        settings,
      );
      await fs.writeFile(outputPath, subpixelSvg, 'utf8');
      return {
        success: true,
        engine: 'subpixel-bezier',
        traceWidth: origInfo.width,
        traceHeight: origInfo.height,
        scaleFactor: 1,
      };
    }

    const palette = extractInteriorPalette(origRaw, origInfo.width, origInfo.height, targetColors);

    let upscalePipeline = sharp(originalPath, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    });
    if (shouldUpscale) {
      upscalePipeline = upscalePipeline
        .resize(traceWidth, traceHeight, { kernel: sharp.kernel.lanczos3 })
        .blur(1.8);
    } else {
      upscalePipeline = upscalePipeline.blur(0.6);
    }

    const { data: upscaledRaw, info: upscaledInfo } = await upscalePipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let transparentPixels = 0;
    if (palette.length > 0) {
      for (let i = 0; i < upscaledRaw.length; i += 4) {
        const a = upscaledRaw[i + 3] ?? 0;
        if (a < 128) {
          upscaledRaw[i] = 0;
          upscaledRaw[i + 1] = 0;
          upscaledRaw[i + 2] = 0;
          upscaledRaw[i + 3] = 0;
          transparentPixels++;
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

    const totalUpscaledPixels = upscaledInfo.width * upscaledInfo.height;
    const hasSignificantTransparency = transparentPixels > totalUpscaledPixels * 0.01;

    if (
      palette.length > 0 &&
      (palette.length === 1 || (palette.length === 2 && !hasSignificantTransparency))
    ) {
      const potraceSvg = await traceWithPotraceDualColor(
        upscaledRaw,
        upscaledInfo.width,
        upscaledInfo.height,
        palette,
        settings,
        scaleFactor,
      );
      await fs.writeFile(outputPath, potraceSvg, 'utf8');
      return {
        success: true,
        engine: 'potrace-bezier',
        traceWidth: upscaledInfo.width,
        traceHeight: upscaledInfo.height,
        scaleFactor,
      };
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

    const scaledFilterSpeckle = Math.min(
      16,
      Math.max(0, Math.round(settings.filterSpeckle * scaleFactor)),
    );
    const scaledSegmentLength = Math.min(10, Math.max(3.5, 6.0 * scaleFactor));

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
        String(settings.cornerThreshold),
        '--segment_length',
        scaledSegmentLength.toFixed(1),
        '--splice_threshold',
        '60',
        '--path_precision',
        '3',
      ],
      { timeout: 30_000 },
    );

    return {
      success: true,
      engine: 'vtracer-native',
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
    await fs.rm(tempInputPath, { force: true }).catch(() => undefined);
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

const simplifyPathD = (d: string, scaleFactor = 1): string => {
  try {
    type AbsoluteArray = ReturnType<typeof SVGPathCommander.pathToAbsolute>;
    const abs = SVGPathCommander.pathToAbsolute(d);
    const minStep = 0.45 * scaleFactor;
    const minStepSq = minStep * minStep;

    const pruned: Array<AbsoluteArray[number]> = [];
    let curX = 0;
    let curY = 0;
    let subStartX = 0;
    let subStartY = 0;

    for (let i = 0; i < abs.length; i++) {
      const seg = abs[i]!;
      const cmd = seg[0];

      if (cmd === 'M') {
        curX = Number(seg[1]);
        curY = Number(seg[2]);
        subStartX = curX;
        subStartY = curY;
        pruned.push(seg);
        continue;
      }

      if (cmd === 'Z') {
        curX = subStartX;
        curY = subStartY;
        pruned.push(seg);
        continue;
      }

      if (cmd === 'L') {
        const nx = Number(seg[1]);
        const ny = Number(seg[2]);
        const dx = nx - curX;
        const dy = ny - curY;
        const nextSeg = abs[i + 1];
        if (dx * dx + dy * dy < minStepSq && nextSeg && nextSeg[0] !== 'Z' && nextSeg[0] !== 'M') {
          continue;
        }
        curX = nx;
        curY = ny;
        pruned.push(seg);
        continue;
      }

      if (cmd === 'C') {
        const nx = Number(seg[5]);
        const ny = Number(seg[6]);
        const dx = nx - curX;
        const dy = ny - curY;
        const nextSeg = abs[i + 1];
        if (dx * dx + dy * dy < minStepSq && nextSeg && nextSeg[0] !== 'Z' && nextSeg[0] !== 'M') {
          continue;
        }
        curX = nx;
        curY = ny;
        pruned.push(seg);
        continue;
      }

      pruned.push(seg);
    }

    if (pruned.length === 0) return d;
    const optimized = SVGPathCommander.optimizePath(pruned as AbsoluteArray);
    const rounded = SVGPathCommander.roundPath(optimized, 2);
    return SVGPathCommander.pathToString(rounded);
  } catch {
    return d;
  }
};

const optimizeVectorSvg = (
  rawSvg: string,
  displayWidth: number,
  displayHeight: number,
  traceWidth = displayWidth,
  traceHeight = displayHeight,
  scaleFactor = 1,
  simplifyNodes = true,
): string => {
  const simplifiedRaw = simplifyNodes
    ? rawSvg.replace(
        /\bd="([^"]+)"/gi,
        (_full, d: string) => `d="${simplifyPathD(d, scaleFactor)}"`,
      )
    : rawSvg;

  const withViewBox = /\bviewBox=/.test(simplifiedRaw)
    ? simplifiedRaw
    : simplifiedRaw.replace(/<svg\b/, `<svg viewBox="0 0 ${traceWidth} ${traceHeight}"`);

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
              floatPrecision: 2,
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
    const vbAttr = hasVb ? '' : ` viewBox="0 0 ${traceWidth} ${traceHeight}"`;
    return `<svg${cleaned}${vbAttr} width="${displayWidth}" height="${displayHeight}">`;
  });
};

const traceAndOptimizeSvg = async (
  inputPath: string,
  outputPath: string,
  settings: VectorSettings,
): Promise<void> => {
  let pipeline = sharp(inputPath, { limitInputPixels: SHARP_LIMIT_INPUT_PIXELS });
  if (settings.filterSpeckle >= 4) {
    pipeline = pipeline.median(settings.filterSpeckle >= 16 ? 5 : 3);
  }

  const { data, info } = await pipeline
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

  const optimizedSvg = optimizeVectorSvg(rawSvg, info.width, info.height);
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
      primaryRes.traceWidth,
      primaryRes.traceHeight,
      primaryRes.scaleFactor,
      primaryRes.engine !== 'potrace-bezier' && primaryRes.engine !== 'subpixel-bezier',
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
