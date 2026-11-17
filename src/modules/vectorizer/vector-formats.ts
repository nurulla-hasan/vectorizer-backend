import SVGPathCommander from 'svg-path-commander';

type CurveSegment = readonly [string, ...number[]];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface ExportShape {
  segments: CurveSegment[];
  fill: Rgb | null;
  fillRule: 'nonzero' | 'evenodd';
  stroke: Rgb | null;
  strokeWidth: number;
  lineCap: 0 | 1 | 2;
  lineJoin: 0 | 1 | 2;
}

interface ParsedSvg {
  width: number;
  height: number;
  shapes: ExportShape[];
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const parseColor = (value: string | undefined): Rgb | null => {
  if (!value || value === 'none' || value === 'transparent') return null;
  const match = value.trim().match(HEX_COLOR);
  let hex = match?.[1];
  if (!hex) return null;
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

const parseAttributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z-]+)="([^"]*)"/g;
  for (const match of raw.matchAll(attrRegex)) {
    const key = match[1];
    const val = match[2];
    if (key && val !== undefined) attrs[key] = val;
  }
  return attrs;
};

const parseSvg = (svg: string, fallbackWidth: number, fallbackHeight: number): ParsedSvg => {
  const viewBox = svg
    .match(/viewBox="([^"]+)"/i)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);

  const widthAttr = Number(svg.match(/\swidth="([^"]+)"/i)?.[1]);
  const heightAttr = Number(svg.match(/\sheight="([^"]+)"/i)?.[1]);

  const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox?.length === 4 ? viewBox[3] : undefined;

  const width =
    viewBoxWidth !== undefined && Number.isFinite(viewBoxWidth) && viewBoxWidth > 0
      ? viewBoxWidth
      : widthAttr > 0
        ? widthAttr
        : fallbackWidth;
  const height =
    viewBoxHeight !== undefined && Number.isFinite(viewBoxHeight) && viewBoxHeight > 0
      ? viewBoxHeight
      : heightAttr > 0
        ? heightAttr
        : fallbackHeight;

  if (!(width > 0) || !(height > 0)) {
    throw new Error('Unable to determine vector dimensions');
  }

  const shapes: ExportShape[] = [];
  const pathRegex = /<path\b([^>]*?)\/?>/gi;

  for (const match of svg.matchAll(pathRegex)) {
    const attrs = parseAttributes(match[1] ?? '');
    if (!attrs.d) continue;

    let segments: CurveSegment[];
    try {
      segments = SVGPathCommander.pathToCurve(attrs.d) as unknown as CurveSegment[];
    } catch {
      continue;
    }
    if (segments.length === 0) continue;

    const fill = parseColor(attrs.fill);
    const stroke = parseColor(attrs.stroke);
    if (!fill && !stroke) continue;

    const cap = attrs['stroke-linecap'];
    const join = attrs['stroke-linejoin'];

    shapes.push({
      segments,
      fill,
      fillRule: attrs['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
      stroke,
      strokeWidth: Number(attrs['stroke-width']) > 0 ? Number(attrs['stroke-width']) : 1,
      lineCap: cap === 'round' ? 1 : cap === 'square' ? 2 : 0,
      lineJoin: join === 'bevel' ? 2 : join === 'miter' ? 0 : 1,
    });
  }

  return { width, height, shapes };
};

const psNumber = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, '');
};

const psColor = (color: Rgb): string =>
  `${psNumber(color.r / 255)} ${psNumber(color.g / 255)} ${psNumber(color.b / 255)} setrgbcolor`;

const psPath = (segments: CurveSegment[]): string[] => {
  const ops: string[] = [];
  for (const segment of segments) {
    const command = segment[0];
    if (command === 'M') {
      ops.push(`${psNumber(segment[1] as number)} ${psNumber(segment[2] as number)} moveto`);
    } else if (command === 'L') {
      ops.push(`${psNumber(segment[1] as number)} ${psNumber(segment[2] as number)} lineto`);
    } else if (command === 'C') {
      ops.push(
        `${psNumber(segment[1] as number)} ${psNumber(segment[2] as number)} ` +
          `${psNumber(segment[3] as number)} ${psNumber(segment[4] as number)} ` +
          `${psNumber(segment[5] as number)} ${psNumber(segment[6] as number)} curveto`,
      );
    } else if (command === 'Z') {
      ops.push('closepath');
    }
  }
  return ops;
};

/** Builds an Encapsulated PostScript document from the generated SVG paths. */
export const renderEpsFromSvg = (
  svg: string,
  fallbackWidth: number,
  fallbackHeight: number,
): Buffer => {
  const { width, height, shapes } = parseSvg(svg, fallbackWidth, fallbackHeight);

  const lines: string[] = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%Creator: Vectorizer',
    '%%Title: Vectorized artwork',
    `%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}`,
    `%%HiResBoundingBox: 0 0 ${psNumber(width)} ${psNumber(height)}`,
    '%%Pages: 1',
    '%%EndComments',
    '%%BeginProlog',
    '/m { moveto } bind def',
    '/l { lineto } bind def',
    '/c { curveto } bind def',
    '/h { closepath } bind def',
    '%%EndProlog',
    '%%Page: 1 1',
    ...psColor({ r: 255, g: 255, b: 255 }),
    `0 0 ${psNumber(width)} ${psNumber(height)} rectfill`,
    `0 ${psNumber(height)} translate`,
    '1 -1 scale',
  ];

  for (const shape of shapes) {
    lines.push('gsave');
    if (shape.fill) {
      lines.push(psColor(shape.fill));
      lines.push(...psPath(shape.segments), shape.fillRule === 'evenodd' ? 'eofill' : 'fill');
    }
    if (shape.stroke) {
      lines.push(psColor(shape.stroke));
      lines.push(`${psNumber(shape.strokeWidth)} setlinewidth`);
      lines.push(`${shape.lineCap} setlinecap`, `${shape.lineJoin} setlinejoin`);
      lines.push(...psPath(shape.segments), 'stroke');
    }
    lines.push('grestore');
  }

  lines.push('showpage', '%%EOF');

  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
};

interface Point {
  x: number;
  y: number;
}

const FLATTEN_TOLERANCE = 0.25;
const MAX_SUBDIVISION_DEPTH = 16;

const distanceToLine = (point: Point, start: Point, end: Point): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
};

const flattenCubic = (
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  depth = 0,
  out: Point[] = [],
): Point[] => {
  const flatEnough =
    distanceToLine(control1, start, end) <= FLATTEN_TOLERANCE &&
    distanceToLine(control2, start, end) <= FLATTEN_TOLERANCE;

  if (flatEnough || depth >= MAX_SUBDIVISION_DEPTH) {
    out.push(end);
    return out;
  }

  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(start, control1);
  const p12 = mid(control1, control2);
  const p23 = mid(control2, end);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);

  flattenCubic(start, p01, p012, p0123, depth + 1, out);
  flattenCubic(p0123, p123, p23, end, depth + 1, out);
  return out;
};

interface Subpath {
  points: Point[];
  closed: boolean;
}

interface Polyline {
  points: Point[];
  closed: boolean;
  color: Rgb;
  width: number | null;
}

/** Splits curve segments into flattened subpaths in the CAD y-up coordinate space. */
const buildSubpaths = (segments: CurveSegment[], height: number): Subpath[] => {
  const subpaths: Subpath[] = [];
  let current: Point[] = [];
  let currentClosed = false;
  let cursor: Point = { x: 0, y: 0 };

  const pushCurrent = () => {
    if (current.length > 1) {
      subpaths.push({
        points: current.map((point) => ({ x: point.x, y: height - point.y })),
        closed: currentClosed,
      });
    }
    current = [];
    currentClosed = false;
  };

  for (const segment of segments) {
    const command = segment[0];
    if (command === 'M') {
      pushCurrent();
      cursor = { x: segment[1] as number, y: segment[2] as number };
      current = [cursor];
    } else if (command === 'L') {
      cursor = { x: segment[1] as number, y: segment[2] as number };
      current.push(cursor);
    } else if (command === 'C') {
      const control1 = { x: segment[1] as number, y: segment[2] as number };
      const control2 = { x: segment[3] as number, y: segment[4] as number };
      const end = { x: segment[5] as number, y: segment[6] as number };
      flattenCubic(cursor, control1, control2, end, 0, current);
      cursor = end;
    } else if (command === 'Z') {
      currentClosed = true;
    }
  }
  pushCurrent();

  return subpaths;
};

const dxfNumber = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3);
};

const dxfPair = (code: number, value: string | number): string[] => [String(code), String(value)];

const trueColor = (color: Rgb): number => (color.r << 16) | (color.g << 8) | color.b;

/** Builds a minimal AC1021 DXF with one closed LWPOLYLINE per filled contour. */
export const renderDxfFromSvg = (
  svg: string,
  fallbackWidth: number,
  fallbackHeight: number,
): Buffer => {
  const { width, height, shapes } = parseSvg(svg, fallbackWidth, fallbackHeight);

  const polylines: Polyline[] = [];
  for (const shape of shapes) {
    const subpaths = buildSubpaths(shape.segments, height);
    for (const subpath of subpaths) {
      if (shape.fill) {
        polylines.push({
          points: subpath.points,
          closed: true,
          color: shape.fill,
          width: null,
        });
      }
      if (shape.stroke) {
        polylines.push({
          points: subpath.points,
          closed: subpath.closed,
          color: shape.stroke,
          width: shape.strokeWidth,
        });
      }
    }
  }

  const lines: string[] = [
    ...dxfPair(0, 'SECTION'),
    ...dxfPair(2, 'HEADER'),
    ...dxfPair(9, '$ACADVER'),
    ...dxfPair(1, 'AC1021'),
    ...dxfPair(9, '$INSUNITS'),
    ...dxfPair(70, 4),
    ...dxfPair(9, '$EXTMIN'),
    ...dxfPair(10, 0),
    ...dxfPair(20, 0),
    ...dxfPair(30, 0),
    ...dxfPair(9, '$EXTMAX'),
    ...dxfPair(10, dxfNumber(width)),
    ...dxfPair(20, dxfNumber(height)),
    ...dxfPair(30, 0),
    ...dxfPair(0, 'ENDSEC'),
    ...dxfPair(0, 'SECTION'),
    ...dxfPair(2, 'TABLES'),
    ...dxfPair(0, 'TABLE'),
    ...dxfPair(2, 'LTYPE'),
    ...dxfPair(70, 1),
    ...dxfPair(0, 'LTYPE'),
    ...dxfPair(2, 'CONTINUOUS'),
    ...dxfPair(70, 64),
    ...dxfPair(3, 'Solid line'),
    ...dxfPair(72, 65),
    ...dxfPair(73, 0),
    ...dxfPair(40, 0),
    ...dxfPair(0, 'ENDTAB'),
    ...dxfPair(0, 'TABLE'),
    ...dxfPair(2, 'LAYER'),
    ...dxfPair(70, 1),
    ...dxfPair(0, 'LAYER'),
    ...dxfPair(2, '0'),
    ...dxfPair(70, 0),
    ...dxfPair(62, 7),
    ...dxfPair(6, 'CONTINUOUS'),
    ...dxfPair(0, 'ENDTAB'),
    ...dxfPair(0, 'ENDSEC'),
    ...dxfPair(0, 'SECTION'),
    ...dxfPair(2, 'ENTITIES'),
  ];

  for (const polyline of polylines) {
    lines.push(
      ...dxfPair(0, 'LWPOLYLINE'),
      ...dxfPair(8, '0'),
      ...dxfPair(90, polyline.points.length),
      ...dxfPair(70, polyline.closed ? 1 : 0),
      ...dxfPair(420, trueColor(polyline.color)),
    );
    if (polyline.width !== null) {
      lines.push(...dxfPair(43, dxfNumber(polyline.width)));
    }
    for (const point of polyline.points) {
      lines.push(...dxfPair(10, dxfNumber(point.x)), ...dxfPair(20, dxfNumber(point.y)));
    }
  }

  lines.push(...dxfPair(0, 'ENDSEC'), ...dxfPair(0, 'EOF'));

  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
};
