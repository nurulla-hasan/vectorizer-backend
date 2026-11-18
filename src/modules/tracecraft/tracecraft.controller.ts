import httpStatus from 'http-status';
import { AppError } from '../../utils/app-error.js';
import { catchAsync } from '../../utils/catch-async.js';
import { sendResponse } from '../../utils/send-response.js';
import { fetchImageFromUrl } from './url-import.js';
import { tracecraftService } from './tracecraft.service.js';
import { exportQuerySchema, vectorJobIdSchema } from './tracecraft.validation.js';

const getJobId = (id: string | string[] | undefined): string => {
  const parsed = vectorJobIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid vector job ID', 'INVALID_JOB_ID');
  }
  return parsed.data;
};

const processImage = catchAsync(async (req, res) => {
  const result = await tracecraftService.processImage(req.file, req.body ?? {}, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Image vectorized successfully',
    data: result,
  });
});

const importFromUrl = catchAsync(async (req, res) => {
  const { url, ...rawSettings } = req.body ?? {};
  const imported = await fetchImageFromUrl(String(url));
  const result = await tracecraftService.processImage(
    {
      buffer: imported.buffer,
      originalname: imported.filename,
      mimetype: imported.mimeType,
    } as Express.Multer.File,
    rawSettings,
    req.user?.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Image imported and vectorized successfully',
    data: result,
  });
});

const getOriginalImage = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const { filePath } = await tracecraftService.getOriginalImageFile(jobId, req.user?.id);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

const getPreview = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await tracecraftService.getPreviewData(jobId, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Vector preview retrieved successfully',
    data: result,
  });
});

const reprocess = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await tracecraftService.reprocessJob(jobId, req.body ?? {}, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image re-vectorized successfully',
    data: result,
  });
});

const saveSvg = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await tracecraftService.saveEditedSvg(
    jobId,
    String(req.body?.svg ?? ''),
    req.user?.id,
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Vector edits saved successfully',
    data: result,
  });
});

const downloadSvg = catchAsync(async (req, res) => {
  if (!req.user?.id) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Authentication required');
  }

  const jobId = getJobId(req.params.id);
  const { format, scale, preset } = exportQuerySchema.parse(req.query);
  const { buffer, mimeType, fileName } = await tracecraftService.exportVectorFile(
    jobId,
    req.user.id,
    format,
    scale,
    preset,
  );

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
});

export const tracecraftController = {
  processImage,
  importFromUrl,
  getOriginalImage,
  getPreview,
  reprocess,
  saveSvg,
  downloadSvg,
};
