import { z } from 'zod';

const bdMobileNumber = z
  .string()
  .trim()
  .regex(/^01[3-9]\d{8}$/, 'Enter a valid 11-digit Bangladeshi mobile number.');

export const createPaymentRequestSchema = z.object({
  planId: z.enum(['pro_monthly', 'pro_yearly']),
  provider: z.enum(['BKASH', 'NAGAD', 'ROCKET']),
  senderNumber: bdMobileNumber,
  transactionId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,30}$/, 'Transaction ID must be 6-30 letters or digits.'),
});

export const rejectPaymentRequestSchema = z.object({
  note: z.string().trim().max(300).optional().default(''),
});

export const listPaymentRequestsQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export type CreatePaymentRequestInput = z.infer<typeof createPaymentRequestSchema>;
export type RejectPaymentRequestInput = z.infer<typeof rejectPaymentRequestSchema>;
export type ListPaymentRequestsQueryInput = z.infer<typeof listPaymentRequestsQuerySchema>;
