/*
  Warnings:

  - Changed the type of `aspect_ratio` on the `generations` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "generations" DROP COLUMN "aspect_ratio",
ADD COLUMN     "aspect_ratio" TEXT NOT NULL;

-- DropEnum
DROP TYPE "AspectRatio";
