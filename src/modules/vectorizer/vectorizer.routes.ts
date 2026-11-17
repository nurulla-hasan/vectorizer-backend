import { Router } from 'express';
import { upload } from '../../lib/multer.js';
import { auth, optionalAuth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { vectorizerController } from './vectorizer.controller.js';
import {
  importUrlSchema,
  reprocessVectorSchema,
  saveEditedSvgSchema,
} from './vectorizer.validation.js';

export const vectorizerRouter = Router();

vectorizerRouter.post(
  '/process',
  optionalAuth,
  upload.single('image'),
  vectorizerController.processImage,
);

vectorizerRouter.post(
  '/import-url',
  optionalAuth,
  validate(importUrlSchema),
  vectorizerController.importFromUrl,
);

vectorizerRouter.get('/:id/original', optionalAuth, vectorizerController.getOriginalImage);

vectorizerRouter.get('/:id/preview', optionalAuth, vectorizerController.getPreview);

vectorizerRouter.post(
  '/:id/reprocess',
  optionalAuth,
  validate(reprocessVectorSchema),
  vectorizerController.reprocess,
);

vectorizerRouter.put(
  '/:id/svg',
  optionalAuth,
  validate(saveEditedSvgSchema),
  vectorizerController.saveSvg,
);

vectorizerRouter.get('/:id/download', auth(), vectorizerController.downloadSvg);
