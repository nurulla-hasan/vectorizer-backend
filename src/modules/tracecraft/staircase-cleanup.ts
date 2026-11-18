import type { AbsoluteArray, PathArray, PathSegment } from 'svg-path-commander';

interface Point {
  x: number;
  y: number;
}

/**
 * Staircase steps in traced output are 1-4 px at display scale. Chains of
 * them are quantization artifacts, not geometry, so they are collapsed to
 * their chord once the chord stays within the staircase's own quantization
 * error. Straightening never moves the outline by more than ~2 px, while real
 * corners deviate far more and are always preserved.
 */
const RDP_TOLERANCE = 0.75;
const RUN_TOLERANCE_FLOOR = 1.1;
const STEP_MAX = 4.2;
const MIN_STEPS = 4;
const MIN_SPAN = 3;

const endpointOf = (segment: PathSegment, current: Point): Point => {
  switch (segment[0]) {
    case 'M':
    case 'L':
    case 'T':
      return { x: segment[1], y: segment[2] };
    case 'H':
      return { x: segment[1], y: current.y };
    case 'V':
      return { x: current.x, y: segment[1] };
    case 'C':
      return { x: segment[5], y: segment[6] };
    case 'S':
    case 'Q':
      return { x: segment[3], y: segment[4] };
    case 'A':
      return { x: segment[6], y: segment[7] };
    default:
      return current;
  }
};

const isMicroCurve = (segment: PathSegment, current: Point, end: Point): boolean => {
  const commands = segment[0];
  if (commands !== 'C' && commands !== 'S' && commands !== 'Q' && commands !== 'T') {
    return false;
  }
  const limit = 1.6;
  for (let i = 1; i + 1 < segment.length; i += 2) {
    const dx = Number(segment[i]) - current.x;
    const dy = Number(segment[i + 1]) - current.y;
    if (dx * dx + dy * dy > limit * limit) return false;
  }
  const dx = end.x - current.x;
  const dy = end.y - current.y;
  return dx * dx + dy * dy <= limit * limit;
};

const pointSegmentDistanceSq = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return px * px + py * py;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
};

const simplifyPolyline = (points: Point[], tolerance: number): Point[] => {
  if (points.length <= 2) return points;
  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let farthestSq = 0;
    let farthest = -1;
    for (let i = first + 1; i < last; i++) {
      const distSq = pointSegmentDistanceSq(points[i]!, points[first]!, points[last]!);
      if (distSq > farthestSq) {
        farthestSq = distSq;
        farthest = i;
      }
    }
    if (farthest !== -1 && farthestSq > toleranceSq) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
};

const pointDistance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

const isAxisStep = (a: Point, b: Point): boolean => {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const length = Math.hypot(dx, dy);
  if (length <= 0.05 || length > STEP_MAX) return false;
  return Math.min(dx, dy) <= 0.5;
};

/**
 * Collapses runs of alternating short axis-aligned steps into their chord.
 * Runs that follow a curved edge fail the run-tolerance check and are instead
 * simplified into a few chords, so curved staircases stay curved.
 */
const collapseStaircaseRuns = (points: Point[]): Point[] => {
  if (points.length <= 3) return points;
  const result: Point[] = [points[0]!];
  let index = 0;

  while (index < points.length - 1) {
    let end = index;
    let maxStep = 0;
    while (end < points.length - 1 && isAxisStep(points[end]!, points[end + 1]!)) {
      maxStep = Math.max(maxStep, pointDistance(points[end]!, points[end + 1]!));
      end++;
    }

    const first = points[index]!;
    const last = points[end]!;
    const qualifies =
      end - index >= MIN_STEPS &&
      Math.abs(last.x - first.x) >= MIN_SPAN &&
      Math.abs(last.y - first.y) >= MIN_SPAN;

    if (qualifies) {
      const runTolerance = Math.max(RUN_TOLERANCE_FLOOR, 0.72 * maxStep);
      const simplified = simplifyPolyline(points.slice(index, end + 1), runTolerance);
      for (let i = 1; i < simplified.length; i++) {
        result.push(simplified[i]!);
      }
      index = end;
      continue;
    }

    result.push(points[index + 1]!);
    index++;
  }

  return result;
};

/**
 * Removes pixel-staircase artifacts from traced paths. Chains of short
 * axis-aligned steps are straightened to their chord (within the staircase's
 * own quantization error), remaining near-collinear line points are dropped
 * sub-pixel, and real corners stay untouched. Short micro-curves are folded
 * into the same chain so mostly-curved staircases are cleaned as well.
 */
export const cleanupStaircaseSegments = (
  absolute: AbsoluteArray,
  tolerance = RDP_TOLERANCE,
): PathArray => {
  const output: PathSegment[] = [];
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = current;
  let chain: Point[] = [];

  const flushChain = () => {
    if (chain.length > 1) {
      const collapsed = collapseStaircaseRuns(chain);
      const simplified = collapsed.length > 2 ? simplifyPolyline(collapsed, tolerance) : collapsed;
      for (let i = 1; i < simplified.length; i++) {
        const point = simplified[i]!;
        output.push(['L', point.x, point.y]);
      }
    }
    chain = [];
  };

  for (const segment of absolute) {
    const command = segment[0];

    if (command === 'M') {
      flushChain();
      current = { x: segment[1], y: segment[2] };
      subpathStart = current;
      output.push(segment);
      chain = [current];
      continue;
    }

    if (command === 'Z') {
      flushChain();
      output.push(segment);
      current = subpathStart;
      chain = [current];
      continue;
    }

    if (command === 'L' || command === 'H' || command === 'V') {
      current = endpointOf(segment, current);
      chain.push(current);
      continue;
    }

    const end = endpointOf(segment, current);
    if (isMicroCurve(segment, current, end)) {
      current = end;
      chain.push(current);
      continue;
    }

    flushChain();
    output.push(segment);
    current = end;
    chain = [current];
  }

  flushChain();
  return output as PathArray;
};
