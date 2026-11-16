import httpStatus from 'http-status';
import multer from 'multer';
import { AppError } from '../utils/app-error.js';

// Memory storage for file buffering
const storage = multer.memoryStorage();

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
]);

export const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          httpStatus.UNPROCESSABLE_ENTITY,
          'Only raster image files (PNG, JPG, WebP, GIF, BMP, TIFF) are allowed.',
          'UNSUPPORTED_IMAGE_FORMAT',
        ),
      );
    }
  },
});

export const uploadDocument = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (JPG, PNG, WebP) are allowed.'));
    }
  },
});
