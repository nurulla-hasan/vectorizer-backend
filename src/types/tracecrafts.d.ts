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
