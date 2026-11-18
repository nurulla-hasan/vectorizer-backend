import fs from "node:fs/promises";
import path from "node:path";
import httpStatus from "http-status";
import sharp from "sharp";
import SVGPathCommander from "svg-path-commander";
import { optimize as optimizeSvg } from "svgo";
import { AppError } from "../../utils/app-error.js";
import {
  type BackgroundColor,
  detectBackgroundColor,
  stripBackgroundFromSvg,
} from "./background-removal.js";
import { cleanupStaircaseSegments } from "./staircase-cleanup.js";
import type { VectorSettings } from "./tracecraft.validation.js";

export const SHARP_LIMIT_INPUT_PIXELS = 25_000_000;

export type VectorEngine = "tracecraft-ai";

export interface VectorPathItem {
  id: string;
  fill: string;
  fillRule?: "nonzero" | "evenodd";
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

const simplifyPathD = (
  d: string,
  scaleFactor = 1,
  preTranslateX = 0,
  preTranslateY = 0,
  smoothStaircase = true,
): string => {
  try {
    let commander = new SVGPathCommander(d);
    if (preTranslateX !== 0 || preTranslateY !== 0) {
      commander = commander.transform({
        translate: [preTranslateX, preTranslateY],
      });
    }
    if (scaleFactor !== 1) {
      commander = commander.transform({
        scale: [1 / scaleFactor, 1 / scaleFactor],
      });
    }
    const abs = SVGPathCommander.pathToAbsolute(commander.toString());
    const cleaned = smoothStaircase ? cleanupStaircaseSegments(abs) : abs;
    const optimized = SVGPathCommander.optimizePath(cleaned);
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
  smoothStaircase = true,
): string => {
  const scaledRaw = rawSvg.replace(
    /<path\b([^>]*?)\/?>/gi,
    (_full, rawAttrs: string) => {
      const dMatch = rawAttrs.match(/\bd="([^"]+)"/i);
      if (!dMatch?.[1]) return _full;

      const origD = dMatch[1];
      const trMatch = rawAttrs.match(
        /\btransform="translate\(([^,)]+),([^)]+)\)"/i,
      );
      const tx = trMatch ? Number.parseFloat(trMatch[1] ?? "0") || 0 : 0;
      const ty = trMatch ? Number.parseFloat(trMatch[2] ?? "0") || 0 : 0;
      const nextD = simplifyPathD(origD, scaleFactor, tx, ty, smoothStaircase);

      const cleanedAttrs = rawAttrs
        .replace(/\s*\btransform="[^"]*"/i, "")
        .replace(/\bd="[^"]+"/i, `d="${nextD}"`);
      return `<path${cleanedAttrs}/>`;
    },
  );

  // Set normalized viewBox in original 1x display dimensions after scaling path coordinates
  const withViewBox = /\bviewBox=/i.test(scaledRaw)
    ? scaledRaw.replace(
        /\bviewBox=["'][^"']*["']/i,
        `viewBox="0 0 ${displayWidth} ${displayHeight}"`,
      )
    : scaledRaw.replace(
        /<svg\b/,
        `<svg viewBox="0 0 ${displayWidth} ${displayHeight}"`,
      );

  const result = optimizeSvg(withViewBox, {
    multipass: true,
    plugins: [
      {
        name: "preset-default",
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
      .replace(/\s*\bwidth=["'][^"']*["']/gi, "")
      .replace(/\s*\bheight=["'][^"']*["']/gi, "");
    const hasVb = /\bviewBox=/.test(cleaned);
    const vbAttr = hasVb
      ? ""
      : ` viewBox="0 0 ${displayWidth} ${displayHeight}"`;
    return `<svg${cleaned}${vbAttr} width="${displayWidth}" height="${displayHeight}">`;
  });
};

const TRACECRAFT_AI_ENDPOINT = "https://api.vectorizer.ai/api/v1/vectorize";
const TRACECRAFT_AI_TIMEOUT_MS = 180_000;

/**
 * Hosted TraceCraft engine (external vectorizer.ai service). Configured through
 * TRACECRAFT_AI_API_ID / TRACECRAFT_AI_API_SECRET. Test modes (test/test_preview)
 * are free but watermark the result; production modes cost credits.
 */
const vectorizeWithAi = async (
  inputPath: string,
  outputPath: string,
  settings: VectorSettings,
  origWidth: number,
): Promise<{ engine: VectorEngine; scaleFactor: number }> => {
  const apiId = process.env.TRACECRAFT_AI_API_ID?.trim();
  const apiSecret = process.env.TRACECRAFT_AI_API_SECRET?.trim();
  if (!apiId || !apiSecret) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "TraceCraft API credentials are not configured (TRACECRAFT_AI_API_ID / TRACECRAFT_AI_API_SECRET)",
    );
  }

  const form = new FormData();
  const imageBuffer = await sharp(inputPath, {
    limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
  })
    .png()
    .toBuffer();
  form.append(
    "image",
    new Blob([imageBuffer], { type: "image/png" }),
    "image.png",
  );
  form.append("mode", process.env.TRACECRAFT_AI_MODE?.trim() || "test");
  form.append("input.max_pixels", "3145828");
  form.append("processing.max_colors", String(settings.maxColors));
  form.append(
    "processing.shapes.min_area_px",
    Math.max(0.125, Math.min(2, settings.filterSpeckle / 8)).toFixed(3),
  );
  form.append("output.file_format", "svg");
  form.append("output.draw_style", "fill_shapes");
  form.append(
    "output.shape_stacking",
    settings.hierarchical === "stacked" ? "stacked" : "cutouts",
  );
  if (settings.mode !== "spline") {
    // polygon/pixel modes request line geometry instead of smooth curves.
    form.append("output.curves.allowed.quadratic_bezier", "false");
    form.append("output.curves.allowed.cubic_bezier", "false");
    form.append("output.curves.allowed.circular_arc", "false");
    form.append("output.curves.allowed.elliptical_arc", "false");
  }
  form.append("policy.retention_days", "0");

  let response: Response;
  try {
    response = await fetch(TRACECRAFT_AI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiId}:${apiSecret}`).toString("base64")}`,
      },
      body: form,
      signal: AbortSignal.timeout(TRACECRAFT_AI_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      `TraceCraft request failed: ${reason}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(
      `[TraceCraft] tracecraft request failed (${response.status}): ${detail.slice(0, 300)}`,
    );
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      `TraceCraft rejected the request (HTTP ${response.status})`,
    );
  }

  const svg = await response.text();
  if (!/<svg\b/i.test(svg)) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "TraceCraft returned a non-SVG response",
    );
  }
  await fs.writeFile(outputPath, svg, "utf8");

  const vb = /<svg\b[^>]*\bviewBox=["']0 0 ([\d.]+) ([\d.]+)["']/i.exec(svg);
  let vbWidth = vb ? Number.parseFloat(vb[1] ?? "") : Number.NaN;
  if (!Number.isFinite(vbWidth) || vbWidth <= 0) {
    const w = /<svg\b[^>]*\bwidth=["']([\d.]+)["']/i.exec(svg);
    vbWidth = w ? Number.parseFloat(w[1] ?? "") : origWidth;
  }

  return {
    engine: "tracecraft-ai",
    // optimizeVectorSvg divides coordinates by this factor: results shrunk by
    // input.max_pixels are scaled back up to the original display dimensions.
    scaleFactor:
      Number.isFinite(vbWidth) && vbWidth > 0 ? vbWidth / origWidth : 1,
  };
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

  let background: BackgroundColor | null = null;
  if (settings.removeBackground) {
    background = await detectBackgroundColor(
      originalPath,
      settings.backgroundTolerance,
    ).catch((error: unknown) => {
      console.warn(
        "[TraceCraft] Background removal skipped:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
  }

  const result = await vectorizeWithAi(
    originalPath,
    svgPath,
    settings,
    origWidth,
  );

  let rawSvg = await fs.readFile(svgPath, "utf8");
  if (background) {
    rawSvg = stripBackgroundFromSvg(
      rawSvg,
      background,
      settings.backgroundTolerance,
    );
  }
  const optimized = optimizeVectorSvg(
    rawSvg,
    origWidth,
    origHeight,
    result.scaleFactor,
    settings.mode !== "pixel",
  );
  await fs.writeFile(svgPath, optimized, "utf8");

  const processingMs = Math.max(1, Math.round(performance.now() - start));
  await fs.writeFile(
    path.join(path.dirname(svgPath), "engine.txt"),
    result.engine,
    "utf8",
  );
  console.info(
    `[TraceCraft] job=${jobId} engine=${result.engine} processingMs=${processingMs}`,
  );

  return { processingMs, engine: result.engine };
};

export const readStoredEngine = async (
  svgPath: string,
): Promise<VectorEngine> => {
  try {
    const val = (
      await fs.readFile(path.join(path.dirname(svgPath), "engine.txt"), "utf8")
    ).trim();
    if (val === "tracecraft-ai") {
      return val;
    }
  } catch {
    // Default if engine metadata file is absent
  }
  return "tracecraft-ai";
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
  let idx = 0;

  for (
    let match = pathRegex.exec(svg);
    match !== null;
    match = pathRegex.exec(svg)
  ) {
    const attrs = match[1] ?? "";
    const dMatch = attrs.match(/\bd=["']([^"']+)["']/i);
    const fillMatch = attrs.match(/\bfill=["']([^"']+)["']/i);
    const strokeMatch = attrs.match(/\bstroke=["']([^"']+)["']/i);
    const fillRuleMatch = attrs.match(/\bfill-rule=["']([^"']+)["']/i);
    const transformMatch = attrs.match(/\btransform=["']([^"']+)["']/i);
    if (!dMatch?.[1]) continue;
    // Stroke-only paths (e.g. the tracecraft.ai watermark) have no fill to render
    // in the fill-based preview; painting them as default black is wrong.
    if (!fillMatch?.[1] && strokeMatch?.[1]) continue;

    const rawFill = fillMatch?.[1] || "#000000";
    const fill = rawFill === "none" ? "none" : normalizeHexColor(rawFill);
    if (fill !== "none") paletteSet.add(fill);

    const rawFillRule = fillRuleMatch?.[1]?.toLowerCase();
    const fillRule =
      rawFillRule === "evenodd" || rawFillRule === "nonzero"
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
