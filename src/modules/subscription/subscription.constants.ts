import type { UserPlan } from '../../../generated/prisma/client';

export type BillingCycleCode = 'MONTHLY' | 'YEARLY';
export type PlanId = 'free' | 'pro_monthly' | 'pro_yearly';
export type PaidPlanId = 'pro_monthly' | 'pro_yearly';

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

export interface SubscriptionPlanItem {
  id: PlanId;
  code: UserPlan;
  stepCode: string;
  label: string;
  badge: string | null;
  highlighted: boolean;
  billingCycle: BillingCycleCode | null;
  amountBdt: number;
  period: string;
  subtext: string;
  description: string;
  creditsLimit: number | null;
  unlimited: boolean;
  features: string[];
}

export const SUBSCRIPTION_PLANS: SubscriptionPlanItem[] = [
  {
    id: 'free',
    code: 'FREE',
    stepCode: 'PLAN 01',
    label: 'Free',
    badge: null,
    highlighted: false,
    billingCycle: null,
    amountBdt: 0,
    period: 'starter credits',
    subtext: 'No credit card required',
    description: 'Try AI-assisted vectorization and inspect paths in the Studio.',
    creditsLimit: 5,
    unlimited: false,
    features: [
      '5 free export credits on sign-up',
      'Full Studio preview & magnifier loupe',
      'Manual anchor & path editing',
      'Clean SVG, PNG, PDF, EPS, and DXF downloads',
    ],
  },
  {
    id: 'pro_monthly',
    code: 'PRO',
    stepCode: 'PLAN 02',
    label: 'Pro Monthly',
    badge: 'Most popular',
    highlighted: true,
    billingCycle: 'MONTHLY',
    amountBdt: 500,
    period: 'per month',
    subtext: 'Flexible month-to-month access',
    description: 'Unlimited high-precision vector exports billed every month.',
    creditsLimit: null,
    unlimited: true,
    features: [
      'Unlimited SVG, PNG (up to 4x), PDF, EPS, and DXF exports',
      'Vectorizer AI precision tracing engine',
      'Full color palette & curve tuning controls',
      'Priority processing queue',
    ],
  },
  {
    id: 'pro_yearly',
    code: 'PRO',
    stepCode: 'PLAN 03',
    label: 'Pro Yearly',
    badge: 'Best value',
    highlighted: false,
    billingCycle: 'YEARLY',
    amountBdt: 5000,
    period: 'per year',
    subtext: 'Save ৳1,000 · 2 months free',
    description: 'Full year of unlimited vector exports — get 2 months free.',
    creditsLimit: null,
    unlimited: true,
    features: [
      'Everything in Pro Monthly for 12 months',
      'Save ৳1,000 compared to monthly',
      'Vectorizer AI precision tracing engine',
      'Priority processing queue',
    ],
  },
];

export const PAID_PLAN_IDS = ['pro_monthly', 'pro_yearly'] as const;

export const getSubscriptionPlanById = (
  planId: string,
): SubscriptionPlanItem | undefined =>
  SUBSCRIPTION_PLANS.find((plan) => plan.id === planId);

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
