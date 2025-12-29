-- AlterTable
ALTER TABLE "SubsPlan" ADD COLUMN     "type" "SubscriptionPlan" NOT NULL DEFAULT 'FREE';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "planType" TEXT,
ADD COLUMN     "remainingDays" INTEGER;
