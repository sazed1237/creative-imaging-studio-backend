/*
  Warnings:

  - The values [PREMIUM_MONTHLY,PREMIUM_YEARLY] on the enum `SubscriptionPlan` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "SubscriptionPlan_new" AS ENUM ('FREE', 'PRO');
ALTER TYPE "SubscriptionPlan" RENAME TO "SubscriptionPlan_old";
ALTER TYPE "SubscriptionPlan_new" RENAME TO "SubscriptionPlan";
DROP TYPE "SubscriptionPlan_old";
COMMIT;

-- AlterTable
ALTER TABLE "SubsPlan" ALTER COLUMN "price" SET DATA TYPE DECIMAL(65,30);
