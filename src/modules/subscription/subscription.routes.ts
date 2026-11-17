import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { subscriptionController } from './subscription.controller';
import { createPaymentRequestSchema, rejectPaymentRequestSchema } from './subscription.validation';

export const subscriptionRouter = Router();

// Public plan catalog and receiving numbers for manual mobile-money payments
subscriptionRouter.get('/plans', subscriptionController.getPlans);
subscriptionRouter.get('/payment-methods', subscriptionController.getPaymentMethods);

// Current user's manual payment requests
subscriptionRouter.post(
  '/requests',
  auth(),
  validate(createPaymentRequestSchema),
  subscriptionController.createPaymentRequest,
);
subscriptionRouter.get('/requests/me', auth(), subscriptionController.getMyPaymentRequests);

// Admin verification queue
subscriptionRouter.get('/requests', auth('ADMIN'), subscriptionController.adminListPaymentRequests);
subscriptionRouter.patch(
  '/requests/:id/approve',
  auth('ADMIN'),
  subscriptionController.approvePaymentRequest,
);
subscriptionRouter.patch(
  '/requests/:id/reject',
  auth('ADMIN'),
  validate(rejectPaymentRequestSchema),
  subscriptionController.rejectPaymentRequest,
);
