import httpStatus from 'http-status';
import { AppError } from '../../utils/app-error.js';
import { catchAsync } from '../../utils/catch-async.js';
import { sendResponse } from '../../utils/send-response.js';
import { vectorizerService } from './vectorizer.service.js';

const getJobId = (id: string | string[] | undefined): string => {
  if (!id || Array.isArray(id)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid vector job ID');
  }
  return id;
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
  const { filePath } = await vectorizerService.getOriginalImageFile(jobId);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

const getPreview = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await vectorizerService.getPreviewData(jobId);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Vector preview retrieved successfully',
    data: result,
  });
});

const reprocess = catchAsync(async (req, res) => {
  const jobId = getJobId(req.params.id);
  const result = await vectorizerService.reprocessJob(jobId, req.body ?? {});

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Image re-vectorized successfully',
    data: result,
  });
});

const downloadSvg = catchAsync(async (req, res) => {
  if (!req.user?.id) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Authentication required');
  }

  const jobId = getJobId(req.params.id);
  const { filePath, fileName } = await vectorizerService.downloadSvgFile(jobId, req.user.id);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.sendFile(filePath);
});

export const vectorizerController = {
  processImage,
  getOriginalImage,
  getPreview,
  reprocess,
  downloadSvg,
};
