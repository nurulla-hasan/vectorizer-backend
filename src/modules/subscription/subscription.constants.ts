import type { UserPlan } from '../../../generated/prisma/client';

export type BillingCycleCode = 'MONTHLY' | 'YEARLY';

export interface PlanPrice {
  billingCycle: BillingCycleCode;
  amountBdt: number;
  period: string;
}

export interface PlanDefinition {
  code: UserPlan;
  label: string;
  creditsLimit: number | null;
  unlimited: boolean;
  description: string;
  prices: PlanPrice[];
}

export const PLAN_CATALOG: Record<UserPlan, PlanDefinition> = {
  FREE: {
    code: 'FREE',
    label: 'Free',
    creditsLimit: 5,
    unlimited: false,
    description: 'Try AI-assisted vectorization and inspect paths in the Studio.',
    prices: [],
  },
  PRO: {
    code: 'PRO',
    label: 'Pro',
    creditsLimit: null,
    unlimited: true,
    description: 'Unlimited high-precision vector exports for designers & teams.',
    prices: [
      { billingCycle: 'MONTHLY', amountBdt: 500, period: 'per month' },
      { billingCycle: 'YEARLY', amountBdt: 5000, period: 'per year' },
    ],
  },
};

export const PAID_PLANS: UserPlan[] = ['PRO'];

export const getPlanPrice = (
  plan: UserPlan,
  billingCycle: BillingCycleCode,
): PlanPrice | undefined =>
  PLAN_CATALOG[plan].prices.find((price) => price.billingCycle === billingCycle);

export type PaymentProviderCode = 'BKASH' | 'NAGAD' | 'ROCKET';

export const PAYMENT_PROVIDER_LABELS: Record<PaymentProviderCode, string> = {
  BKASH: 'bKash',
  NAGAD: 'Nagad',
  ROCKET: 'Rocket',
};
