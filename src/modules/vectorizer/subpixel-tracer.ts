import type { VectorSettings } from './vectorizer.validation.js';

interface Point2D {
  x: number;
  y: number;
}

interface EdgeSegmentPoint extends Point2D {
  key: string;
}

export interface TwoPoleAnalysis {
  isTwoPole: boolean;
  hasTransparentBg: boolean;
  bgRgb: [number, number, number];
  fgRgb: [number, number, number];
  field: Float64Array;
}

const rgbToHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

const distSq3 = (
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number => (r1 - r2) * (r1 - r2) + (g1 - g2) * (g1 - g2) + (b1 - b2) * (b1 - b2);

const normalizeVec = (x: number, y: number): Point2D => {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
};

/**
 * Analyze raw RGBA pixels to detect whether an image is:
 *  A) Single-color artwork over transparent background (`field = alpha / 255`), or
 *  B) Two-color (foreground + background + anti-aliased edge gradient) where >= 94% of pixels
 *     lie along the 1D RGB line segment [bgRgb, fgRgb] (eliminating blurred gray gradient halos).
 */
export const detectTwoPoleField = (
  rgba: Buffer,
  width: number,
  height: number,
  colorPrecision: number,
): TwoPoleAnalysis | null => {
  const total = width * height;
  if (total === 0) return null;

  let transparentCount = 0;
  let opaqueCount = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) < 128) transparentCount++;
    else opaqueCount++;
  }
  if (opaqueCount === 0) return null;

  // Case A: Single-color silhouette over transparent background
  if (transparentCount > total * 0.02) {
    let minR = 255;
    let maxR = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let count = 0;
    const solidColors: Array<[number, number, number]> = [];
    for (let i = 0; i < rgba.length; i += 4) {
      if ((rgba[i + 3] ?? 0) < 220) continue;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      sr += r;
      sg += g;
      sb += b;
      count++;
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      if (solidColors.length < 2000) solidColors.push([r, g, b]);
    }

    if (count > 0 && solidColors.length > 0) {
      const avgRgb: [number, number, number] = [
        Math.round(sr / count),
        Math.round(sg / count),
        Math.round(sb / count),
      ];
      let closeToAvg = 0;
      for (const [r, g, b] of solidColors) {
        if (distSq3(r, g, b, avgRgb[0], avgRgb[1], avgRgb[2]) <= 40 * 40) {
          closeToAvg++;
        }
      }
      if (closeToAvg / solidColors.length >= 0.94 && maxR - minR < 90) {
        const pw = width + 2;
        const ph = height + 2;
        const field = new Float64Array(pw * ph);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            field[(y + 1) * pw + (x + 1)] = (rgba[(y * width + x) * 4 + 3] ?? 0) / 255;
          }
        }
        return {
          isTwoPole: true,
          hasTransparentBg: true,
          bgRgb: [255, 255, 255],
          fgRgb: avgRgb,
          field,
        };
      }
    }
    return null;
  }

  // Case B: Opaque 2-pole image (median border = bg, furthest high-contrast pixels = fg)
  const borderR: number[] = [];
  const borderG: number[] = [];
  const borderB: number[] = [];
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) >= 128) {
        borderR.push(rgba[idx] ?? 0);
        borderG.push(rgba[idx + 1] ?? 0);
        borderB.push(rgba[idx + 2] ?? 0);
      }
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) >= 128) {
        borderR.push(rgba[idx] ?? 0);
        borderG.push(rgba[idx + 1] ?? 0);
        borderB.push(rgba[idx + 2] ?? 0);
      }
    }
  }
  if (borderR.length === 0) return null;

  borderR.sort((a, b) => a - b);
  borderG.sort((a, b) => a - b);
  borderB.sort((a, b) => a - b);
  const mid = Math.floor(borderR.length / 2);
  const bgRgb: [number, number, number] = [
    borderR[mid]!,
    borderG[mid]!,
    borderB[mid]!,
  ];

  // Collect high-contrast candidate pixels away from bg
  const stride = total > 400_000 ? 2 : 1;
  const distSamples: Array<[number, number, number, number]> = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) < 128) continue;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      const d2 = distSq3(r, g, b, bgRgb[0], bgRgb[1], bgRgb[2]);
      if (d2 > 45 * 45) {
        distSamples.push([d2, r, g, b]);
      }
    }
  }

  if (distSamples.length < 12) return null;
  distSamples.sort((a, b) => b[0] - a[0]);
  const topN = Math.max(1, Math.min(distSamples.length, Math.max(20, Math.floor(distSamples.length * 0.15))));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let k = 0; k < topN; k++) {
    sr += distSamples[k]![1];
    sg += distSamples[k]![2];
    sb += distSamples[k]![3];
  }
  const fgRgb: [number, number, number] = [
    Math.round(sr / topN),
    Math.round(sg / topN),
    Math.round(sb / topN),
  ];

  const vx = fgRgb[0] - bgRgb[0];
  const vy = fgRgb[1] - bgRgb[1];
  const vz = fgRgb[2] - bgRgb[2];
  const vLenSq = vx * vx + vy * vy + vz * vz;
  if (vLenSq < 45 * 45) return null;

  // Verify all pixels lie along the 1D RGB segment [bgRgb, fgRgb] (reject true multi-color art)
  const tolerance = Math.max(22, 38 - colorPrecision * 2);
  const toleranceSq = tolerance * tolerance;
  let checked = 0;
  let colinear = 0;
  let nearPoles = 0;
  let chromaticMids = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) < 128) continue;
      checked++;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      const tRaw = ((r - bgRgb[0]) * vx + (g - bgRgb[1]) * vy + (b - bgRgb[2]) * vz) / vLenSq;
      const t = Math.max(0, Math.min(1, tRaw));
      const pr = bgRgb[0] + t * vx;
      const pg = bgRgb[1] + t * vy;
      const pb = bgRgb[2] + t * vz;
      if (distSq3(r, g, b, pr, pg, pb) <= toleranceSq) {
        colinear++;
      }
      // True two-pole art is bimodal: nearly all pixels hug one pole and only a thin
      // anti-aliasing ramp sits between. Flat multi-tone illustrations are colinear too
      // but put large areas on mid tones, which a 2-pole binarizer would delete.
      if (t <= 0.15 || t >= 0.85) {
        nearPoles++;
      } else if (Math.max(r, g, b) - Math.min(r, g, b) > 24) {
        chromaticMids++;
      }
    }
  }

  if (checked === 0 || colinear / checked < 0.94) {
    return null;
  }
  // A neutral (achromatic) mid-tone band is a soft drop shadow/glow around line art —
  // that still binarizes cleanly onto the two poles. Large *colored* mid-tone areas
  // (e.g. a light-blue deck in an illustration) would be deleted, so reject those.
  const nearPoleRatio = nearPoles / checked;
  const chromaticMidRatio = chromaticMids / checked;
  if (nearPoleRatio < 0.9 && !(nearPoleRatio >= 0.6 && chromaticMidRatio <= 0.02)) {
    return null;
  }

  // Project full image onto normalized scalar coverage field [0..1] with 1px zero border padding
  const pw = width + 2;
  const ph = height + 2;
  const field = new Float64Array(pw * ph);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      const t = ((r - bgRgb[0]) * vx + (g - bgRgb[1]) * vy + (b - bgRgb[2]) * vz) / vLenSq;
      field[(y + 1) * pw + (x + 1)] = Math.max(0, Math.min(1, t));
    }
  }

  return {
    isTwoPole: true,
    hasTransparentBg: false,
    bgRgb,
    fgRgb,
    field,
  };
};

const CASE_EDGES: Record<number, Array<[number, number]>> = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[1, 0]],
  6: [[2, 0]],
  7: [[3, 0]],
  8: [[0, 3]],
  9: [[0, 2]],
  11: [[0, 1]],
  12: [[1, 3]],
  13: [[1, 2]],
  14: [[2, 3]],
};

const extractSubpixelLoops = (
  field: Float64Array,
  pw: number,
  ph: number,
  minArea: number,
): Point2D[][] => {
  const ISO = 0.5;
  const segs: Array<[EdgeSegmentPoint, EdgeSegmentPoint]> = [];

  const interp = (v0: number, v1: number): number => {
    const d = v1 - v0;
    return Math.abs(d) < 1e-9 ? 0.5 : Math.max(0.001, Math.min(0.999, (ISO - v0) / d));
  };

  const edgePt = (
    cx: number,
    cy: number,
    edgeIdx: number,
    tl: number,
    tr: number,
    br: number,
    bl: number,
  ): EdgeSegmentPoint => {
    let x: number;
    let y: number;
    if (edgeIdx === 0) {
      x = cx + interp(tl, tr);
      y = cy;
    } else if (edgeIdx === 1) {
      x = cx + 1;
      y = cy + interp(tr, br);
    } else if (edgeIdx === 2) {
      x = cx + interp(bl, br);
      y = cy + 1;
    } else {
      x = cx;
      y = cy + interp(tl, bl);
    }
    return {
      x: x - 0.5,
      y: y - 0.5,
      key: `${edgeIdx === 1 ? cx + 1 : cx}:${edgeIdx === 2 ? cy + 1 : cy}:${edgeIdx % 2 === 0 ? 'h' : 'v'}`,
    };
  };

  for (let cy = 0; cy < ph - 1; cy++) {
    for (let cx = 0; cx < pw - 1; cx++) {
      const tl = field[cy * pw + cx]!;
      const tr = field[cy * pw + cx + 1]!;
      const br = field[(cy + 1) * pw + cx + 1]!;
      const bl = field[(cy + 1) * pw + cx]!;

      const code =
        (tl >= ISO ? 8 : 0) | (tr >= ISO ? 4 : 0) | (br >= ISO ? 2 : 0) | (bl >= ISO ? 1 : 0);
      if (code === 0 || code === 15) continue;

      let pairs: Array<[number, number]>;
      if (code === 5 || code === 10) {
        const center = (tl + tr + br + bl) * 0.25;
        pairs =
          code === 5
            ? center >= ISO
              ? [[3, 0], [1, 2]]
              : [[3, 2], [1, 0]]
            : center >= ISO
              ? [[0, 1], [2, 3]]
              : [[0, 3], [2, 1]];
      } else {
        pairs = CASE_EDGES[code] ?? [];
      }

      for (const [e0, e1] of pairs) {
        segs.push([edgePt(cx, cy, e0, tl, tr, br, bl), edgePt(cx, cy, e1, tl, tr, br, bl)]);
      }
    }
  }

  const adj = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const startKey = segs[i]![0].key;
    const list = adj.get(startKey);
    if (list) list.push(i);
    else adj.set(startKey, [i]);
  }

  const used = new Uint8Array(segs.length);
  const polyArea = (pts: Point2D[]): number => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i]!.x * pts[j]!.y - pts[j]!.x * pts[i]!.y;
    }
    return Math.abs(a) * 0.5;
  };

  const loops: Point2D[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const loop: Point2D[] = [];
    let cur: number | undefined = i;
    while (cur !== undefined && !used[cur]) {
      used[cur] = 1;
      const [p0, p1] = segs[cur]!;
      loop.push({ x: p0.x, y: p0.y });
      const candidates = adj.get(p1.key);
      cur = candidates?.find((idx) => !used[idx]);
    }
    if (loop.length >= 6 && polyArea(loop) >= minArea) {
      loops.push(loop);
    }
  }

  return loops;
};

const estimateEdgeBlurPx = (field: Float64Array, pw: number, ph: number): number => {
  const grads: number[] = [];
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      const t = field[y * pw + x]!;
      if (t > 0.25 && t < 0.75) {
        const gx = (field[y * pw + x + 1]! - field[y * pw + x - 1]!) * 0.5;
        const gy = (field[(y + 1) * pw + x]! - field[(y - 1) * pw + x]!) * 0.5;
        const g = Math.hypot(gx, gy);
        if (g > 0.02) grads.push(g);
      }
    }
  }
  if (grads.length === 0) return 1.5;
  grads.sort((a, b) => a - b);
  const medGrad = grads[Math.floor(grads.length * 0.5)] ?? 0.3;
  return Math.max(1.0, Math.min(4.0, 0.5 / medGrad));
};

const resampleLoopUniform = (pts: Point2D[], step = 1.0): Point2D[] => {
  const n = pts.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    cum.push(cum[i]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const perim = cum[n] ?? 0;
  const count = Math.max(8, Math.round(perim / step));
  const out: Point2D[] = [];
  let seg = 0;

  for (let k = 0; k < count; k++) {
    const target = (k * perim) / count;
    while (seg < n - 1 && cum[seg + 1]! < target) seg++;
    const segLen = cum[seg + 1]! - cum[seg]! || 1;
    const t = (target - cum[seg]!) / segLen;
    const a = pts[seg]!;
    const b = pts[(seg + 1) % n]!;
    out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }
  return out;
};

const gaussianSmoothNonCorners = (
  arr: Point2D[],
  pinnedMask: Uint8Array | null,
  sigma: number,
): Point2D[] => {
  const n = arr.length;
  const radius = Math.max(2, Math.min(Math.floor(n / 6), Math.ceil(sigma * 2.2)));
  const weights: number[] = [];
  for (let d = -radius; d <= radius; d++) {
    weights.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  }

  const out = arr.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < n; i++) {
    if (pinnedMask && pinnedMask[i]) continue;
    let maxR = radius;
    if (pinnedMask) {
      for (let d = 1; d <= radius; d++) {
        if (pinnedMask[(i - d + n) % n] || pinnedMask[(i + d) % n]) {
          maxR = d - 1;
          break;
        }
      }
    }
    if (maxR < 1) continue;

    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let d = -maxR; d <= maxR; d++) {
      const w = weights[d + radius]!;
      const p = arr[(i + d + n) % n]!;
      sx += p.x * w;
      sy += p.y * w;
      sw += w;
    }
    out[i] = { x: sx / sw, y: sy / sw };
  }
  return out;
};

const refineAndSharpenLoop = (
  rawPts: Point2D[],
  cornerThresholdDeg: number,
  edgeBlurPx: number,
) => {
  let pts = resampleLoopUniform(rawPts, 1.0);
  const n = pts.length;
  const prePts = gaussianSmoothNonCorners(pts, null, 0.9);

  const kNear = Math.max(2, Math.min(3, Math.floor(n / 6)));
  const kArm = Math.max(4, Math.min(6, Math.floor(n / 4)));
  const corners = new Uint8Array(n);
  const score = new Float64Array(n);

  // Higher cornerThreshold allows fewer sharper corners; lower detects subtler corners
  const macroThreshRad = Math.max(
    0.45,
    Math.min(1.65, ((180 - cornerThresholdDeg) / 110) * 0.82),
  );
  const nearMinRad = Math.max(0.32, macroThreshRad * 0.72);

  const chordAngle = (arr: Point2D[], i: number, k: number): number => {
    const pL = arr[(i - k + n) % n]!;
    const pC = arr[i]!;
    const pR = arr[(i + k) % n]!;
    const v1 = normalizeVec(pC.x - pL.x, pC.y - pL.y);
    const v2 = normalizeVec(pR.x - pC.x, pR.y - pC.y);
    return Math.acos(Math.max(-1, Math.min(1, v1.x * v2.x + v1.y * v2.y)));
  };

  for (let i = 0; i < n; i++) {
    const aNear = chordAngle(prePts, i, kNear);
    const aMacro = chordAngle(prePts, i, kArm);
    if (aMacro < macroThreshRad || aNear < nearMinRad) continue;

    // Peak concentration check separates sharp corners (< / L) from smooth rounded stroke caps (U)
    const leftBend = chordAngle(prePts, (i - kNear + n) % n, kNear);
    const rightBend = chordAngle(prePts, (i + kNear) % n, kNear);
    const maxSide = Math.max(leftBend, rightBend);

    if (
      aNear >= Math.max(nearMinRad, maxSide * 1.48) ||
      (aMacro >= 1.95 && aNear >= 0.85 && maxSide < 0.65)
    ) {
      score[i] = aMacro + aNear;
    }
  }

  for (let i = 0; i < n; i++) {
    const s = score[i]!;
    if (s <= 0) continue;
    let isMax = true;
    for (let d = 1; d <= kArm; d++) {
      if (score[(i - d + n) % n]! > s || score[(i + d) % n]! > s) {
        isMax = false;
        break;
      }
    }
    if (isMax) corners[i] = 1;
  }

  // Blur-adaptive Gaussian contour fairing melts blurry S-wiggles while preserving corner tips
  const sigma = Math.max(0.8, Math.min(4.2, edgeBlurPx * 1.05, n * 0.04));
  pts = gaussianSmoothNonCorners(pts, corners, sigma);

  // Bounded ray intersection + local arm tangent vectors for curved cusps
  const armTanIn = new Map<number, Point2D>();
  const armTanOut = new Map<number, Point2D>();
  const armStart = 1;
  const armEnd = Math.min(Math.floor(n / 8), 4);

  for (let i = 0; i < n; i++) {
    if (!corners[i]) continue;
    const pIn1 = pts[(i - armStart + n) % n]!;
    const pIn2 = pts[(i - armEnd + n) % n]!;
    const pOut1 = pts[(i + armStart) % n]!;
    const pOut2 = pts[(i + armEnd) % n]!;
    const d1x = pIn1.x - pIn2.x;
    const d1y = pIn1.y - pIn2.y;
    const d2x = pOut1.x - pOut2.x;
    const d2y = pOut1.y - pOut2.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) > 1e-4) {
      const t = ((pOut1.x - pIn1.x) * d2y - (pOut1.y - pIn1.y) * d2x) / denom;
      const ix = pIn1.x + t * d1x;
      const iy = pIn1.y + t * d1y;
      if (Math.hypot(ix - pts[i]!.x, iy - pts[i]!.y) <= 0.9) {
        pts[i] = { x: ix, y: iy };
      }
    }
    armTanOut.set(i, normalizeVec(pOut2.x - pts[i]!.x, pOut2.y - pts[i]!.y));
    armTanIn.set(i, normalizeVec(pIn2.x - pts[i]!.x, pIn2.y - pts[i]!.y));
  }

  return { pts, corners, armTanIn, armTanOut };
};

type CubicSegment = [Point2D, Point2D, Point2D, Point2D];

const evalCubic = (b: CubicSegment, t: number): Point2D => {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * b[0].x + 3 * mt * mt * t * b[1].x + 3 * mt * t * t * b[2].x + t * t * t * b[3].x,
    y: mt * mt * mt * b[0].y + 3 * mt * mt * t * b[1].y + 3 * mt * t * t * b[2].y + t * t * t * b[3].y,
  };
};

const fitCubicBezierSpan = (
  pts: Point2D[],
  tHat1: Point2D,
  tHat2: Point2D,
  maxErrSq: number,
): CubicSegment[] => {
  const m = pts.length;
  if (m === 2) {
    const p0 = pts[0]!;
    const p1 = pts[1]!;
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 3;
    return [
      [
        p0,
        { x: p0.x + tHat1.x * dist, y: p0.y + tHat1.y * dist },
        { x: p1.x + tHat2.x * dist, y: p1.y + tHat2.y * dist },
        p1,
      ],
    ];
  }

  const u = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    u[i] = u[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  const totalLen = u[m - 1]! || 1;
  for (let i = 1; i < m; i++) u[i] = u[i]! / totalLen;

  const p0 = pts[0]!;
  const p3 = pts[m - 1]!;
  const C: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  const X: [number, number] = [0, 0];

  for (let i = 0; i < m; i++) {
    const t = u[i]!;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const a1x = tHat1.x * b1;
    const a1y = tHat1.y * b1;
    const a2x = tHat2.x * b2;
    const a2y = tHat2.y * b2;
    C[0][0] += a1x * a1x + a1y * a1y;
    C[0][1] += a1x * a2x + a1y * a2y;
    C[1][0] = C[0][1];
    C[1][1] += a2x * a2x + a2y * a2y;
    const pt = pts[i]!;
    const tx = pt.x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const ty = pt.y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    X[0] += a1x * tx + a1y * ty;
    X[1] += a2x * tx + a2y * ty;
  }

  const det = C[0][0] * C[1][1] - C[0][1] * C[1][0];
  let alpha1: number;
  let alpha2: number;
  if (Math.abs(det) < 1e-6) {
    alpha1 = totalLen / 3;
    alpha2 = totalLen / 3;
  } else {
    alpha1 = (C[1][1] * X[0] - C[0][1] * X[1]) / det;
    alpha2 = (C[0][0] * X[1] - C[1][0] * X[0]) / det;
  }

  const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps) {
    alpha1 = segLen / 3;
    alpha2 = segLen / 3;
  }

  const bez: CubicSegment = [
    p0,
    { x: p0.x + tHat1.x * alpha1, y: p0.y + tHat1.y * alpha1 },
    { x: p3.x + tHat2.x * alpha2, y: p3.y + tHat2.y * alpha2 },
    p3,
  ];

  let maxErr = 0;
  let splitIdx = Math.floor(m / 2);
  for (let i = 1; i < m - 1; i++) {
    const q = evalCubic(bez, u[i]!);
    const pt = pts[i]!;
    const err = (pt.x - q.x) * (pt.x - q.x) + (pt.y - q.y) * (pt.y - q.y);
    if (err >= maxErr) {
      maxErr = err;
      splitIdx = i;
    }
  }

  if (maxErr < maxErrSq || splitIdx <= 0 || splitIdx >= m - 1) {
    return [bez];
  }

  const centerTan = normalizeVec(
    pts[splitIdx - 1]!.x - pts[splitIdx + 1]!.x,
    pts[splitIdx - 1]!.y - pts[splitIdx + 1]!.y,
  );
  return [
    ...fitCubicBezierSpan(pts.slice(0, splitIdx + 1), tHat1, centerTan, maxErrSq),
    ...fitCubicBezierSpan(pts.slice(splitIdx), { x: -centerTan.x, y: -centerTan.y }, tHat2, maxErrSq),
  ];
};

/**
 * Trace continuous sub-pixel iso-contours directly from anti-aliased coverage gradients,
 * reconstructing razor-sharp corners and fitting minimal Philip Schneider cubic Beziers.
 */
export const traceSubpixelTwoPoleSvg = (
  analysis: TwoPoleAnalysis,
  width: number,
  height: number,
  settings: VectorSettings,
): string => {
  const minArea = Math.max(2, settings.filterSpeckle * 0.5);
  const edgeBlurPx = estimateEdgeBlurPx(analysis.field, width + 2, height + 2);
  const loops = extractSubpixelLoops(analysis.field, width + 2, height + 2, minArea);

  // Adaptive curve error scaled cleanly to edge blur width (melts upscaled staircase ripples)
  const baseErr = Math.max(0.32, Math.min(1.65, edgeBlurPx * 0.42));
  const maxErrSq = baseErr * baseErr;

  let pathD = '';
  for (const rawLoop of loops) {
    const { pts, corners, armTanIn, armTanOut } = refineAndSharpenLoop(
      rawLoop,
      settings.cornerThreshold,
      edgeBlurPx,
    );
    const n = pts.length;
    const cornerIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (corners[i]) cornerIndices.push(i);
    }
    if (cornerIndices.length === 0) cornerIndices.push(0);

    const numSpans = cornerIndices.length;
    for (let s = 0; s < numSpans; s++) {
      const start = cornerIndices[s]!;
      const end = cornerIndices[(s + 1) % numSpans]!;
      const spanPts: Point2D[] = [];
      let idx = start;
      while (true) {
        spanPts.push(pts[idx]!);
        if (idx === end && spanPts.length > 1) break;
        idx = (idx + 1) % n;
        if (spanPts.length > n + 1) break;
      }

      if (spanPts.length < 2) continue;

      if (settings.mode === 'polygon') {
        for (let i = 0; i < spanPts.length; i++) {
          const pt = spanPts[i]!;
          if (s === 0 && i === 0) pathD += `M${pt.x.toFixed(3)} ${pt.y.toFixed(3)}`;
          else pathD += `L${pt.x.toFixed(3)} ${pt.y.toFixed(3)}`;
        }
        continue;
      }

      const lead = Math.min(6, Math.max(1, Math.floor((spanPts.length - 1) / 3)));
      const firstPt = spanPts[0]!;
      const lastPt = spanPts[spanPts.length - 1]!;
      const tHat1 =
        armTanOut.get(start) ??
        normalizeVec(spanPts[lead]!.x - firstPt.x, spanPts[lead]!.y - firstPt.y);
      const tHat2 =
        armTanIn.get(end) ??
        normalizeVec(
          spanPts[spanPts.length - 1 - lead]!.x - lastPt.x,
          spanPts[spanPts.length - 1 - lead]!.y - lastPt.y,
        );

      const cubics = fitCubicBezierSpan(spanPts, tHat1, tHat2, maxErrSq);
      for (let c = 0; c < cubics.length; c++) {
        const b = cubics[c]!;
        if (s === 0 && c === 0) pathD += `M${b[0].x.toFixed(3)} ${b[0].y.toFixed(3)}`;
        pathD += `C${b[1].x.toFixed(3)} ${b[1].y.toFixed(3)} ${b[2].x.toFixed(3)} ${b[2].y.toFixed(3)} ${b[3].x.toFixed(3)} ${b[3].y.toFixed(3)}`;
      }
    }
    pathD += 'Z';
  }

  const fgHex = rgbToHex(analysis.fgRgb);
  const bgPath = analysis.hasTransparentBg
    ? ''
    : `<path d="M0 0H${width}V${height}H0Z" fill="${rgbToHex(analysis.bgRgb)}"/>`;
  const fgPath = pathD
    ? `<path d="${pathD}" fill="${fgHex}" fill-rule="evenodd"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${bgPath}${fgPath}</svg>`;
};
