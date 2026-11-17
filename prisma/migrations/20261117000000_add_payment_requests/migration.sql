-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('BKASH', 'NAGAD', 'ROCKET');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" "UserPlan" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "amount" INTEGER NOT NULL,
    "sender_number" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT NOT NULL DEFAULT '',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_requests_user_id_status_idx" ON "payment_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "payment_requests_status_created_at_idx" ON "payment_requests"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_provider_transaction_id_key" ON "payment_requests"("provider", "transaction_id");

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

