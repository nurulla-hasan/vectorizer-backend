import httpStatus from 'http-status';
import config from '../../config/index';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/app-error';
import {
  getSubscriptionPlanById,
  PAYMENT_PROVIDER_LABELS,
  type PaymentProviderCode,
  SUBSCRIPTION_PLANS,
} from './subscription.constants';
import type {
  CreatePaymentRequestInput,
  RejectPaymentRequestInput,
} from './subscription.validation';

const paymentMethods = [
  { provider: 'BKASH' as const, number: config.payment_bkash_number },
  { provider: 'NAGAD' as const, number: config.payment_nagad_number },
  { provider: 'ROCKET' as const, number: config.payment_rocket_number },
];

const getPlans = () => SUBSCRIPTION_PLANS;

const getPaymentMethods = () =>
  paymentMethods
    .filter((method) => method.number.trim().length > 0)
    .map((method) => ({
      provider: method.provider,
      label: PAYMENT_PROVIDER_LABELS[method.provider as PaymentProviderCode],
      number: method.number,
    }));

const createPaymentRequestIntoDB = async (userId: string, payload: CreatePaymentRequestInput) => {
  const selectedPlan = getSubscriptionPlanById(payload.planId);

  if (!selectedPlan || selectedPlan.code === 'FREE' || !selectedPlan.billingCycle) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Invalid subscription plan selected.',
      'INVALID_PLAN',
    );
  }

  const pending = await prisma.paymentRequest.findFirst({
    where: { userId, status: 'PENDING' },
    select: { id: true },
  });

  if (pending) {
    throw new AppError(
      httpStatus.CONFLICT,
      'You already have a payment request waiting for verification.',
      'PAYMENT_ALREADY_PENDING',
    );
  }

  const reusedTransaction = await prisma.paymentRequest.findUnique({
    where: {
      provider_transactionId: {
        provider: payload.provider,
        transactionId: payload.transactionId,
      },
    },
    select: { id: true },
  });

  if (reusedTransaction) {
    throw new AppError(
      httpStatus.CONFLICT,
      'This transaction ID has already been submitted.',
      'TRANSACTION_ALREADY_USED',
    );
  }

  return prisma.paymentRequest.create({
    data: {
      userId,
      plan: selectedPlan.code,
      billingCycle: selectedPlan.billingCycle,
      provider: payload.provider,
      amount: selectedPlan.amountBdt,
      senderNumber: payload.senderNumber,
      transactionId: payload.transactionId,
    },
  });
};

const getMyPaymentRequestsFromDB = (userId: string) =>
  prisma.paymentRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

const listPaymentRequestsFromDB = (status?: 'PENDING' | 'APPROVED' | 'REJECTED') =>
  prisma.paymentRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { id: true, name: true, email: true, plan: true } },
    },
  });

const approvePaymentRequestIntoDB = async (requestId: string, adminId: string) => {
  return prisma.$transaction(async (tx) => {
    const request = await tx.paymentRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new AppError(httpStatus.NOT_FOUND, 'Payment request not found');
    }
    if (request.status !== 'PENDING') {
      throw new AppError(
        httpStatus.CONFLICT,
        `This payment request is already ${request.status.toLowerCase()}.`,
        'PAYMENT_NOT_PENDING',
      );
    }

    const user = await tx.user.findUnique({
      where: { id: request.userId },
      select: { id: true, plan: true },
    });

    if (!user) {
      throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    const updatedRequest = await tx.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { plan: request.plan },
    });

    return updatedRequest;
  });
};

const rejectPaymentRequestIntoDB = async (
  requestId: string,
  adminId: string,
  payload: RejectPaymentRequestInput,
) => {
  const request = await prisma.paymentRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new AppError(httpStatus.NOT_FOUND, 'Payment request not found');
  }
  if (request.status !== 'PENDING') {
    throw new AppError(
      httpStatus.CONFLICT,
      `This payment request is already ${request.status.toLowerCase()}.`,
      'PAYMENT_NOT_PENDING',
    );
  }

  return prisma.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: 'REJECTED',
      adminNote: payload.note ?? '',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    },
  });
};

export const subscriptionService = {
  getPlans,
  getPaymentMethods,
  createPaymentRequestIntoDB,
  getMyPaymentRequestsFromDB,
  listPaymentRequestsFromDB,
  approvePaymentRequestIntoDB,
  rejectPaymentRequestIntoDB,
};
