import { Router } from 'express';
import { upload } from '../../lib/multer.js';
import { optionalAuth } from '../../middlewares/auth.js';
import { vectorizeController } from './vectorize.controller.js';

export const vectorizeRouter = Router();

vectorizeRouter.post('/', optionalAuth, upload.single('image'), vectorizeController.vectorizeImage);
