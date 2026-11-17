import httpStatus from 'http-status';
import { AppError } from '../../utils/app-error.js';
import { catchAsync } from '../../utils/catch-async.js';
import { sendResponse } from '../../utils/send-response.js';
import { vectorizerService } from './vectorizer.service.js';
import { exportQuerySchema, vectorJobIdSchema } from './vectorizer.validation.js';

const getJobId = (id: string | string[] | undefined): string => {
  const parsed = vectorJobIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid vector job ID', 'INVALID_JOB_ID');
  }
  return parsed.data;
};

const processImage = catchAsync(async (req, res) => {
  const result = await vectorizerService.processImage(req.file, req.body ?? {}, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Image vectorized successfully',
    data: result,
  });
});

const getOriginalImage = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const { filePath } = await vectorizerService.getOriginalImageFile(jobId, req.user?.id);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

const getPreview = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await vectorizerService.getPreviewData(jobId, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Vector preview retrieved successfully',
    data: result,
  });
});

const reprocess = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await vectorizerService.reprocessJob(jobId, req.body ?? {}, req.user?.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image re-vectorized successfully',
    data: result,
  });
});

const saveSvg = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await vectorizerService.saveEditedSvg(
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
  const { format, scale } = exportQuerySchema.parse(req.query);
  const { buffer, mimeType, fileName } = await vectorizerService.exportVectorFile(
    jobId,
    req.user.id,
    format,
    scale,
  );

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
});

export const vectorizerController = {
  processImage,
  getOriginalImage,
  getPreview,
  reprocess,
  saveSvg,
  downloadSvg,
};
