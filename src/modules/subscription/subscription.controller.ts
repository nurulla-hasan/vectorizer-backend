import type { RequestHandler } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catch-async';
import { sendResponse } from '../../utils/send-response';
import { subscriptionService } from './subscription.service';
import { listPaymentRequestsQuerySchema } from './subscription.validation';

const getPlans = catchAsync(async (_req, res) => {
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Plans retrieved',
    data: { plans: subscriptionService.getPlans() },
  });
});

const getPaymentMethods = catchAsync(async (_req, res) => {
  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Payment methods retrieved',
    data: { methods: subscriptionService.getPaymentMethods() },
  });
});

const createPaymentRequest = catchAsync(async (req, res) => {
  const request = await subscriptionService.createPaymentRequestIntoDB(
    req.user?.id as string,
    req.body,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.CREATED,
    message: 'Payment request submitted. We will verify it shortly.',
    data: { request },
  });
});

const getMyPaymentRequests = catchAsync(async (req, res) => {
  const requests = await subscriptionService.getMyPaymentRequestsFromDB(req.user?.id as string);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Payment requests retrieved',
    data: { requests },
  });
});

const adminListPaymentRequests = catchAsync(async (req, res) => {
  const query = listPaymentRequestsQuerySchema.parse(req.query);
  const requests = await subscriptionService.listPaymentRequestsFromDB(query.status);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Payment requests retrieved',
    data: { requests },
  });
});

const approvePaymentRequest: RequestHandler = catchAsync(async (req, res) => {
  const request = await subscriptionService.approvePaymentRequestIntoDB(
    req.params.id as string,
    req.user?.id as string,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Payment approved and plan updated',
    data: { request },
  });
});

const rejectPaymentRequest = catchAsync(async (req, res) => {
  const request = await subscriptionService.rejectPaymentRequestIntoDB(
    req.params.id as string,
    req.user?.id as string,
    req.body,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Payment request rejected',
    data: { request },
  });
});

export const subscriptionController = {
  getPlans,
  getPaymentMethods,
  createPaymentRequest,
  getMyPaymentRequests,
  adminListPaymentRequests,
  approvePaymentRequest,
  rejectPaymentRequest,
};
