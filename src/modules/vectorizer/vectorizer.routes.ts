import { Router } from 'express';
import { upload } from '../../lib/multer.js';
import { auth, optionalAuth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { vectorizerController } from './vectorizer.controller.js';
import { reprocessVectorSchema } from './vectorizer.validation.js';

export const vectorizerRouter = Router();

vectorizerRouter.post(
  '/process',
  optionalAuth,
  upload.single('image'),
  vectorizerController.processImage,
);

vectorizerRouter.get('/:id/original', optionalAuth, vectorizerController.getOriginalImage);

vectorizerRouter.get('/:id/preview', optionalAuth, vectorizerController.getPreview);

vectorizerRouter.post(
  '/:id/reprocess',
  optionalAuth,
  validate(reprocessVectorSchema),
  vectorizerController.reprocess,
);

vectorizerRouter.get('/:id/download', auth(), vectorizerController.downloadSvg);
