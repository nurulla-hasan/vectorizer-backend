declare module 'imagetracerjs' {
  export interface ImageTracerData {
    width: number;
    height: number;
    data: Uint8ClampedArray | Uint8Array | number[];
  }

  export interface ImageTracerOptions {
    corsenabled?: boolean;
    ltres?: number;
    qtres?: number;
    pathomit?: number;
    rightangleenhance?: boolean;
    colorsampling?: number;
    numberofcolors?: number;
    mincolorratio?: number;
    colorquantcycles?: number;
    layering?: number;
    strokewidth?: number;
    linefilter?: boolean;
    scale?: number;
    roundcoords?: number;
    viewbox?: boolean;
    desc?: boolean;
    lcpr?: number;
    qcpr?: number;
    blurradius?: number;
    blurdelta?: number;
  }

  export function imagedataToSVG(
    imgd: ImageTracerData,
    options?: ImageTracerOptions | string,
  ): string;
}

declare module 'potrace' {
  export interface PotraceOptions {
    turnPolicy?: string;
    turdSize?: number;
    alphaMax?: number;
    optCurve?: boolean;
    optTolerance?: number;
    threshold?: number;
    blackOnWhite?: boolean;
    color?: string;
    background?: string;
  }

  export interface PosterizerOptions extends PotraceOptions {
    steps?: number | number[];
    fillStrategy?: string;
    rangeDistribution?: string;
  }

  export function trace(
    file: string | Buffer,
    options: PotraceOptions,
    cb: (err: Error | null, svg: string) => void,
  ): void;

  export function posterize(
    file: string | Buffer,
    options: PosterizerOptions,
    cb: (err: Error | null, svg: string) => void,
  ): void;
}

declare module 'svg-to-pdfkit' {
  import type PDFKit from 'pdfkit';

  export interface SvgToPdfOptions {
    width?: number;
    height?: number;
    assumePt?: boolean;
    preserveAspectRatio?: string;
    useCSS?: boolean;
  }

  export default function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: SvgToPdfOptions,
  ): void;
}
