import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import httpStatus from 'http-status';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import SVGtoPDF from 'svg-to-pdfkit';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import {
  parseSvgPreview,
  readStoredEngine,
  runVectorization,
  SHARP_LIMIT_INPUT_PIXELS,
  type VectorEngine,
  type VectorPathItem,
  type VectorPreviewData,
} from './vectorizer.engine.js';
import {
  type ExportFormat,
  type VectorSettings,
  vectorSettingsSchema,
} from './vectorizer.validation.js';

export type { VectorEngine, VectorPathItem, VectorPreviewData };

const STORAGE_ROOT = path.resolve(process.cwd(), 'storage', 'vectors');
const MAX_DIMENSION = 2048;
const ALLOWED_RASTER_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif', 'tiff', 'heif']);

const resolveSafeStoragePath = (targetPath: string): string => {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(STORAGE_ROOT + path.sep)) {
    throw new AppError(httpStatus.FORBIDDEN, 'Invalid storage path');
  }
  return resolved;
};

/**
 * Prevent IDOR: user-owned jobs are private to that owner; guest jobs (`userId === null`)
 * remain accessible via their opaque UUID to support guest preview -> login -> export.
 */
const assertJobAccess = (jobUserId: string | null, requestUserId?: string): void => {
  if (jobUserId && jobUserId !== requestUserId) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'You do not have permission to access this vector job',
      'JOB_FORBIDDEN',
    );
  }
};

const sanitizeDownloadBasename = (rawName: string): string => {
  const parsed = path.parse(rawName).name;
  const cleaned = parsed
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'vectorized';
};

const validateRasterUpload = async (buffer: Buffer): Promise<void> => {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new AppError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'Invalid or oversized raster image file.',
      'INVALID_IMAGE',
    );
  }

  if (!metadata.format || !ALLOWED_RASTER_FORMATS.has(metadata.format)) {
    throw new AppError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'Unsupported image format. Please upload PNG, JPG, WebP, or GIF.',
      'UNSUPPORTED_IMAGE_FORMAT',
    );
  }
};

const processImage = async (
  file: Express.Multer.File | undefined,
  rawSettings: Partial<VectorSettings>,
  userId?: string,
) => {
  if (!file) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Please upload an image file');
  }

  await validateRasterUpload(file.buffer);
  const settings = vectorSettingsSchema.parse(rawSettings);

  const jobId = crypto.randomUUID();
  const jobDir = path.join(STORAGE_ROOT, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const originalPath = path.join(jobDir, 'original.png');
  const svgPath = path.join(jobDir, 'vector.svg');
  let jobCreated = false;

  try {
    const info = await sharp(file.buffer, {
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toFile(originalPath);
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
    jobCreated = true;

    const { processingMs, engine } = await runVectorization(
      jobId,
      originalPath,
      svgPath,
      settings,
    );

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

    return {
      ...updatedJob,
      engine,
    };
  } catch (error) {
    if (jobCreated) {
      await prisma.vectorJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);
    } else {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
};

const getOriginalImageFile = async (jobId: string, requestUserId?: string) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
    select: { id: true, userId: true, originalPath: true, originalName: true },
  });

  if (!job) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  assertJobAccess(job.userId, requestUserId);

  const safePath = resolveSafeStoragePath(job.originalPath);
  await fs.access(safePath).catch(() => {
    throw new AppError(httpStatus.NOT_FOUND, 'Original image file not found');
  });

  return {
    filePath: safePath,
    originalName: job.originalName,
  };
};

const getPreviewData = async (jobId: string, requestUserId?: string) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
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

  assertJobAccess(job.userId, requestUserId);

  if (job.status !== 'COMPLETED' || !job.svgPath) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Vector preview is not ready');
  }

  const safePath = resolveSafeStoragePath(job.svgPath);
  const [svg, engine] = await Promise.all([
    fs.readFile(safePath, 'utf8'),
    readStoredEngine(safePath),
  ]);
  const preview = parseSvgPreview(svg, job.width, job.height);

  return {
    id: job.id,
    width: job.width,
    height: job.height,
    processingMs: job.processingMs,
    engine,
    settings: job.settings,
    preview,
  };
};

const reprocessJob = async (
  jobId: string,
  rawSettings: Partial<VectorSettings>,
  requestUserId?: string,
) => {
  const job = await prisma.vectorJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  assertJobAccess(job.userId, requestUserId);

  const existingSettings = (job.settings as Partial<VectorSettings> | null) ?? {};
  const mergedSettings = vectorSettingsSchema.parse({
    ...existingSettings,
    ...rawSettings,
  });

  const safeOriginalPath = resolveSafeStoragePath(job.originalPath);
  const safeSvgPath = resolveSafeStoragePath(
    job.svgPath || path.join(path.dirname(safeOriginalPath), 'vector.svg'),
  );

  const { processingMs, engine } = await runVectorization(
    jobId,
    safeOriginalPath,
    safeSvgPath,
    mergedSettings,
  );

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
    engine,
    preview,
  };
};

const renderPdfFromSvg = (svg: string, width: number, height: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [Math.max(1, width), Math.max(1, height)],
      margin: 0,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));

    SVGtoPDF(doc, svg, 0, 0, {
      width,
      height,
      assumePt: true,
    });
    doc.end();
  });

const exportVectorFile = async (
  jobId: string,
  userId: string,
  format: ExportFormat = 'svg',
  scale = 2,
) => {
  const foundJob = await prisma.vectorJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
      originalName: true,
      width: true,
      height: true,
      status: true,
      svgPath: true,
    },
  });

  if (!foundJob) {
    throw new AppError(httpStatus.NOT_FOUND, 'Vector job not found');
  }

  assertJobAccess(foundJob.userId, userId);

  if (foundJob.status !== 'COMPLETED' || !foundJob.svgPath) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Vector file is not ready for download');
  }

  const safePath = resolveSafeStoragePath(foundJob.svgPath);
  await fs.access(safePath).catch(() => {
    throw new AppError(httpStatus.NOT_FOUND, 'Generated SVG file not found');
  });

  const baseName = sanitizeDownloadBasename(foundJob.originalName);
  const svgBuffer = await fs.readFile(safePath);

  let outputBuffer: Buffer;
  let mimeType: string;
  let fileName: string;

  if (format === 'png') {
    const targetWidth = Math.max(1, foundJob.width * scale);
    const targetHeight = Math.max(1, foundJob.height * scale);
    outputBuffer = await sharp(svgBuffer, {
      density: 72 * scale,
      limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
    })
      .resize(targetWidth, targetHeight)
      .png()
      .toBuffer();
    mimeType = 'image/png';
    fileName = `${baseName}-${scale}x.png`;
  } else if (format === 'pdf') {
    outputBuffer = await renderPdfFromSvg(
      svgBuffer.toString('utf8'),
      foundJob.width,
      foundJob.height,
    );
    mimeType = 'application/pdf';
    fileName = `${baseName}.pdf`;
  } else {
    outputBuffer = svgBuffer;
    mimeType = 'image/svg+xml';
    fileName = `${baseName}.svg`;
  }

  // Charge export credit and claim guest job only after artifact generation succeeds
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true },
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
          'INSUFFICIENT_CREDITS',
        );
      }
    }

    if (!foundJob.userId) {
      await tx.vectorJob.updateMany({
        where: { id: foundJob.id, userId: null },
        data: { userId },
      });
    }
  });

  return {
    buffer: outputBuffer,
    mimeType,
    fileName,
  };
};

export const vectorizerService = {
  processImage,
  getOriginalImageFile,
  getPreviewData,
  reprocessJob,
  exportVectorFile,
  runVectorization,
  parseSvgPreview,
};
