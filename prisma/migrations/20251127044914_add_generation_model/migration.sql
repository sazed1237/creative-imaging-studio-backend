-- CreateTable
CREATE TABLE "generations" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "aspect_ratio" TEXT NOT NULL,
    "style" TEXT,
    "style_image" TEXT,
    "image_url" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
