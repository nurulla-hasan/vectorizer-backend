import sharp from 'sharp';
import { SVGPathCommander } from 'svg-path-commander';

const SHARP_LIMIT_INPUT_PIXELS = 25_000_000;
const ALPHA_OPAQUE = 128;
const MIN_UNIFORM_BORDER_RATIO = 0.35;

export interface BackgroundColor {
  r: number;
  g: number;
  b: number;
}

const distSq = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number =>
  (r1 - r2) * (r1 - r2) + (g1 - g2) * (g1 - g2) + (b1 - b2) * (b1 - b2);

const channelMedian = (values: number[]): number => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
};

/**
 * Returns the border-dominant color of the image, or null when the image already has
 * transparency or no uniform border.
 */
export const detectBackgroundColor = async (
  inputPath: string,
  tolerance: number,
): Promise<BackgroundColor | null> => {
  const { data, info } = await sharp(inputPath, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width === 0 || height === 0) return null;

  let transparentCount = 0;
  const borderR: number[] = [];
  const borderG: number[] = [];
  const borderB: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if ((data[idx + 3] ?? 0) < ALPHA_OPAQUE) {
        transparentCount++;
        continue;
      }
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        borderR.push(data[idx] ?? 0);
        borderG.push(data[idx + 1] ?? 0);
        borderB.push(data[idx + 2] ?? 0);
      }
    }
  }

  if (transparentCount > width * height * 0.02) return null;
  if (borderR.length === 0) return null;

  const bg: BackgroundColor = {
    r: channelMedian(borderR),
    g: channelMedian(borderG),
    b: channelMedian(borderB),
  };

  const toleranceSq = tolerance * tolerance;
  let uniformBorder = 0;
  for (let i = 0; i < borderR.length; i++) {
    if (
      distSq(borderR[i] ?? 0, borderG[i] ?? 0, borderB[i] ?? 0, bg.r, bg.g, bg.b) <= toleranceSq
    ) {
      uniformBorder++;
    }
  }
  if (uniformBorder / borderR.length < MIN_UNIFORM_BORDER_RATIO) return null;

  return bg;
};

/**
 * Removes background-colored shapes that reach the canvas border. Local keying before
 * tracing leaves the anti-aliased blend ring behind as a pale halo, so the background
 * stays in the raster and is dropped here instead, at the vector level.
 */
export const stripBackgroundFromSvg = (
  svg: string,
  bg: BackgroundColor,
  tolerance: number,
): string => {
  const vb = /viewBox=["']([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)["']/i.exec(svg);
  if (!vb) return svg;
  const minX = Number.parseFloat(vb[1] ?? '0');
  const minY = Number.parseFloat(vb[2] ?? '0');
  const vbWidth = Number.parseFloat(vb[3] ?? '');
  const vbHeight = Number.parseFloat(vb[4] ?? '');
  if (!Number.isFinite(vbWidth) || !Number.isFinite(vbHeight)) return svg;

  const eps = Math.max(1.5, Math.max(vbWidth, vbHeight) * 0.004);
  const toleranceSq = tolerance * tolerance;

  return svg.replace(/<path\b[^>]*?\/>/gi, (element) => {
    const fill = /\bfill=["']#([0-9a-fA-F]{6})["']/i.exec(element);
    const d = /\bd=["']([^"']+)["']/i.exec(element);
    if (!fill?.[1] || !d?.[1]) return element;

    const hex = fill[1];
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    if (distSq(r, g, b, bg.r, bg.g, bg.b) > toleranceSq) return element;

    let bbox: { x: number; y: number; x2: number; y2: number };
    try {
      bbox = new SVGPathCommander(d[1]).getBBox();
    } catch {
      return element;
    }
    const touchesBorder =
      bbox.x <= minX + eps ||
      bbox.y <= minY + eps ||
      bbox.x2 >= minX + vbWidth - eps ||
      bbox.y2 >= minY + vbHeight - eps;
    return touchesBorder ? '' : element;
  });
};
