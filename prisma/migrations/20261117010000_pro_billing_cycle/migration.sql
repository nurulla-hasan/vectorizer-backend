-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterEnum
BEGIN;
CREATE TYPE "UserPlan_new" AS ENUM ('FREE', 'PRO');
ALTER TABLE "public"."users" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "payment_requests" ALTER COLUMN "plan" TYPE "UserPlan_new" USING ("plan"::text::"UserPlan_new");
ALTER TABLE "users" ALTER COLUMN "plan" TYPE "UserPlan_new" USING ("plan"::text::"UserPlan_new");
ALTER TYPE "UserPlan" RENAME TO "UserPlan_old";
ALTER TYPE "UserPlan_new" RENAME TO "UserPlan";
DROP TYPE "public"."UserPlan_old";
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'FREE';
COMMIT;

-- AlterTable
ALTER TABLE "payment_requests" ADD COLUMN     "billing_cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY';

