import { Router } from 'express';
import { upload } from '../../lib/multer.js';
import { auth, optionalAuth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { tracecraftController } from './tracecraft.controller.js';
import {
  importUrlSchema,
  reprocessVectorSchema,
  saveEditedSvgSchema,
} from './tracecraft.validation.js';

export const tracecraftRouter = Router();

tracecraftRouter.post(
  '/process',
  optionalAuth,
  upload.single('image'),
  tracecraftController.processImage,
);

tracecraftRouter.post(
  '/import-url',
  optionalAuth,
  validate(importUrlSchema),
  tracecraftController.importFromUrl,
);

tracecraftRouter.get('/:id/original', optionalAuth, tracecraftController.getOriginalImage);

tracecraftRouter.get('/:id/preview', optionalAuth, tracecraftController.getPreview);

tracecraftRouter.post(
  '/:id/reprocess',
  optionalAuth,
  validate(reprocessVectorSchema),
  tracecraftController.reprocess,
);

tracecraftRouter.put(
  '/:id/svg',
  optionalAuth,
  validate(saveEditedSvgSchema),
  tracecraftController.saveSvg,
);

tracecraftRouter.get('/:id/download', auth(), tracecraftController.downloadSvg);
