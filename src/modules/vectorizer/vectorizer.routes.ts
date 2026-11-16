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

vectorizerRouter.get('/:id/original', vectorizerController.getOriginalImage);

vectorizerRouter.get('/:id/preview', vectorizerController.getPreview);

vectorizerRouter.post(
  '/:id/reprocess',
  validate(reprocessVectorSchema),
  vectorizerController.reprocess,
);

vectorizerRouter.get('/:id/download', auth(), vectorizerController.downloadSvg);
