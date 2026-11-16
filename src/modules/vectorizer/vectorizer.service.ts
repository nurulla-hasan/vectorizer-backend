import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import httpStatus from 'http-status';
import sharp from 'sharp';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { type VectorSettings, vectorSettingsSchema } from './vectorizer.validation.js';

const execFileAsync = promisify(execFile);

const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'vectors');
const MAX_DIMENSION = 2048;

export interface VectorPathItem {
  id: string;
  fill: string;
  d: string;
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

const resolveSafeStoragePath = (targetPath: string): string => {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(STORAGE_ROOT + path.sep)) {
    throw new AppError(httpStatus.FORBIDDEN, 'Invalid storage path');
  }
  return resolved;
};

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;

/**
 * Attempt vectorization via native vtracer binary if installed on the host.
 */
const tryVtracerBinary = async (
  inputPath: string,
  outputPath: string,
  settings: VectorSettings,
): Promise<boolean> => {
  const binary = process.env.VTRACER_PATH || 'vtracer';
  try {
    await execFileAsync(
      binary,
      [
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--colormode',
        'color',
        '--hierarchical',
        settings.hierarchical,
        '--mode',
        settings.mode,
        '--filter_speckle',
        String(settings.filterSpeckle),
        '--color_precision',
        String(settings.colorPrecision),
        '--corner_threshold',
        String(settings.cornerThreshold),
      ],
      { timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Built-in multi-color SVG path generator using sharp pixel quantization
 * and horizontal run-length region merging so vectorization works out-of-the-box.
 */
const generateFallbackSvg = async (
  inputPath: string,
  outputPath: string,
  settings: VectorSettings,
): Promise<void> => {
  const meta = await sharp(inputPath).metadata();
  const origW = meta.width || 1;
  const origH = meta.height || 1;

  // Trace on a bounded working grid for fast, clean SVG path output
  const maxTraceDim = 256;
  const scale = Math.min(1, maxTraceDim / Math.max(origW, origH));
  const tw = Math.max(1, Math.round(origW * scale));
  const th = Math.max(1, Math.round(origH * scale));
  const sx = origW / tw;
  const sy = origH / th;

  const { data } = await sharp(inputPath)
    .resize(tw, th, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Quantize step derived from colorPrecision (1..8)
  const shift = Math.max(1, 9 - settings.colorPrecision);
  const step = 1 << shift;
  const half = step >> 1;

  const colorRuns = new Map<string, Array<{ x: number; y: number; w: number }>>();
  const colorCounts = new Map<string, number>();

  for (let y = 0; y < th; y++) {
    let runColor: string | null = null;
    let runStart = 0;

    for (let x = 0; x <= tw; x++) {
      let hex: string | null = null;
      if (x < tw) {
        const idx = (y * tw + x) * 4;
        const a = data[idx + 3] ?? 0;
        if (a >= 32) {
          const r = Math.min(255, Math.floor((data[idx] ?? 0) / step) * step + half);
          const g = Math.min(255, Math.floor((data[idx + 1] ?? 0) / step) * step + half);
          const b = Math.min(255, Math.floor((data[idx + 2] ?? 0) / step) * step + half);
          hex = toHex(r, g, b);
        }
      }

      if (hex !== runColor) {
        if (runColor !== null) {
          const w = x - runStart;
          const list = colorRuns.get(runColor) ?? [];
          list.push({ x: runStart, y, w });
          colorRuns.set(runColor, list);
          colorCounts.set(runColor, (colorCounts.get(runColor) ?? 0) + w);
        }
        runColor = hex;
        runStart = x;
      }
    }
  }

  // Keep top maxColors and filter tiny speckles
  const sortedColors = [...colorCounts.entries()]
    .filter(([, count]) => count >= Math.max(1, settings.filterSpeckle))
    .sort((a, b) => b[1] - a[1])
    .slice(0, settings.maxColors);

  const fmt = (n: number) => Number(n.toFixed(2));
  const pathElements: string[] = [];

  for (const [hex] of sortedColors) {
    const runs = colorRuns.get(hex);
    if (!runs || runs.length === 0) continue;

    const dParts: string[] = [];
    for (const run of runs) {
      const x1 = fmt(run.x * sx);
      const y1 = fmt(run.y * sy);
      const x2 = fmt((run.x + run.w) * sx);
      const y2 = fmt((run.y + 1) * sy);
      dParts.push(`M${x1} ${y1}H${x2}V${y2}H${x1}Z`);
    }
    pathElements.push(`  <path fill="${hex}" d="${dParts.join('')}" />`);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${origW} ${origH}" width="${origW}" height="${origH}">`,
    ...pathElements,
    `</svg>`,
  ].join('\n');

  await fs.writeFile(outputPath, svg, 'utf8');
};

const runVectorization = async (
  originalPath: string,
  svgPath: string,
  settings: VectorSettings,
): Promise<number> => {
  const start = performance.now();
  const usedVtracer = await tryVtracerBinary(originalPath, svgPath, settings);
  if (!usedVtracer) {
    await generateFallbackSvg(originalPath, svgPath, settings);
  }
  return Math.max(1, Math.round(performance.now() - start));
};

const parseSvgPreview = (svg: string, width: number, height: number): VectorPreviewData => {
  const paths: VectorPathItem[] = [];
  const paletteSet = new Set<string>();

  const pathRegex = /<path\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pathRegex.exec(svg)) !== null) {
    const attrs = match[1] ?? '';
    const dMatch = attrs.match(/\bd=["']([^"']+)["']/i);
    const fillMatch = attrs.match(/\bfill=["']([^"']+)["']/i);
    if (!dMatch?.[1]) continue;

    const fill = fillMatch?.[1] || '#000000';
    if (fill !== 'none') paletteSet.add(fill);

    paths.push({
      id: `p_${idx++}`,
      fill,
      d: dMatch[1],
    });
  }

  return {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    pathCount: paths.length,
    palette: [...paletteSet],
    paths,
    svg,
  };
};

const processImage = async (
  file: Express.Multer.File | undefined,
  rawSettings: Partial<VectorSettings>,
  userId?: string,
) => {
  if (!file) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Please upload an image file');
  }

  const settings = vectorSettingsSchema.parse(rawSettings);
  const jobId = crypto.randomUUID();
  const jobDir = path.join(STORAGE_ROOT, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const originalPath = path.join(jobDir, 'original.png');
  const svgPath = path.join(jobDir, 'vector.svg');

  try {
    let pipeline = sharp(file.buffer)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });

    if (settings.filterSpeckle >= 8) {
      pipeline = pipeline.median(3);
    }

    const info = await pipeline.png().toFile(originalPath);
    const width = info.width;
    const height = info.height;

    const job = await prisma.vectorJob.create({
      data: {
        id: jobId,
        userId: userId ?? null,
        originalName: file.originalname,
        width,
        height,
        status: 'PROCESSING',
        settings: settings as unknown as Prisma.InputJsonValue,
        originalPath,
      },
    });

    const processingMs = await runVectorization(originalPath, svgPath, settings);

    const updatedJob = await prisma.vectorJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        svgPath,
        processingMs,
      },
      select: {
        id: true,
        originalName: true,
        width: true,
        height: true,
        status: true,
        settings: true,
        processingMs: true,
        createdAt: true,
      },
    });

    return updatedJob;
  } catch (error) {
    await prisma.vectorJob
      .update({
        where: { id: jobId },
        data: { status: 'FAILED' },
      })
      .catch(() => undefined);
    throw error;
  }
};

const getOriginalImageFile = async (jobId: string) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
    select: { id: true, originalPath: true, originalName: true },
  });

  if (!job) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  const safePath = resolveSafeStoragePath(job.originalPath);
  await fs.access(safePath).catch(() => {
    throw new AppError(httpStatus.NOT_FOUND, 'Original image file not found');
  });

  return {
    filePath: safePath,
    originalName: job.originalName,
  };
};

const getPreviewData = async (jobId: string) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      width: true,
      height: true,
      status: true,
      settings: true,
      svgPath: true,
      processingMs: true,
    },
  });

  if (!job) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  if (job.status !== 'COMPLETED' || !job.svgPath) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Vector preview is not ready');
  }

  const safePath = resolveSafeStoragePath(job.svgPath);
  const svg = await fs.readFile(safePath, 'utf8');
  const preview = parseSvgPreview(svg, job.width, job.height);

  return {
    id: job.id,
    width: job.width,
    height: job.height,
    processingMs: job.processingMs,
    settings: job.settings,
    preview,
  };
};

const reprocessJob = async (jobId: string, rawSettings: Partial<VectorSettings>) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  const existingSettings = (job.settings as Partial<VectorSettings> | null) ?? {};
  const mergedSettings = vectorSettingsSchema.parse({
    ...existingSettings,
    ...rawSettings,
  });

  const safeOriginalPath = resolveSafeStoragePath(job.originalPath);
  const safeSvgPath = resolveSafeStoragePath(
    job.svgPath || path.join(path.dirname(safeOriginalPath), 'vector.svg'),
  );

  const processingMs = await runVectorization(safeOriginalPath, safeSvgPath, mergedSettings);

  const updated = await prisma.vectorJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      settings: mergedSettings as unknown as Prisma.InputJsonValue,
      svgPath: safeSvgPath,
      processingMs,
    },
    select: {
      id: true,
      originalName: true,
      width: true,
      height: true,
      status: true,
      settings: true,
      processingMs: true,
      updatedAt: true,
    },
  });

  const svg = await fs.readFile(safeSvgPath, 'utf8');
  const preview = parseSvgPreview(svg, updated.width, updated.height);

  return {
    ...updated,
    preview,
  };
};

const downloadSvgFile = async (jobId: string, userId: string) => {
  const job = await prisma.$transaction(async (tx) => {
    const foundJob = await tx.vectorJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        originalName: true,
        status: true,
        svgPath: true,
      },
    });

    if (!foundJob) {
      throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
    }

    if (foundJob.status !== 'COMPLETED' || !foundJob.svgPath) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Vector file is not ready for download');
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true, credits: true },
    });

    if (!user) {
      throw new AppError(httpStatus.UNAUTHORIZED, 'User not found');
    }

    if (user.plan === 'FREE') {
      const updated = await tx.user.updateMany({
        where: { id: userId, credits: { gt: 0 } },
        data: { credits: { decrement: 1 } },
      });

      if (updated.count === 0) {
        throw new AppError(
          httpStatus.FORBIDDEN,
          'Insufficient credits. Please upgrade to PRO or API plan to download.',
        );
      }
    }

    return foundJob;
  });

  const safePath = resolveSafeStoragePath(job.svgPath!);
  await fs.access(safePath).catch(() => {
    throw new AppError(httpStatus.NOT_FOUND, 'Generated SVG file not found');
  });

  const baseName = path.parse(job.originalName).name || 'vectorized';
  return {
    filePath: safePath,
    fileName: `${baseName}.svg`,
  };
};

export const vectorizerService = {
  processImage,
  getOriginalImageFile,
  getPreviewData,
  reprocessJob,
  downloadSvgFile,
};
