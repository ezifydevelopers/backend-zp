-- Add adminId field to User table for data isolation
ALTER TABLE "users" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Branch table for data isolation
ALTER TABLE "branches" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Category table for data isolation
ALTER TABLE "categories" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Supplier table for data isolation
ALTER TABLE "suppliers" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Product table for data isolation
ALTER TABLE "products" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Customer table for data isolation
ALTER TABLE "customers" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Sale table for data isolation
ALTER TABLE "sales" ADD COLUMN "adminId" TEXT;

-- Add adminId field to SaleItem table for data isolation
ALTER TABLE "sale_items" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Receipt table for data isolation
ALTER TABLE "receipts" ADD COLUMN "adminId" TEXT;

-- Add adminId field to Refund table for data isolation
ALTER TABLE "refunds" ADD COLUMN "adminId" TEXT;

-- Add adminId field to RefundItem table for data isolation
ALTER TABLE "refund_items" ADD COLUMN "adminId" TEXT;

-- Add adminId field to StockMovement table for data isolation
ALTER TABLE "stock_movements" ADD COLUMN "adminId" TEXT;

-- First, create a default admin user if none exists
INSERT INTO "users" ("id", "username", "email", "password", "name", "role", "isActive", "createdAt", "updatedAt")
SELECT 'default-admin-id', 'default-admin', 'admin@default.com', '$2b$10$default', 'Default Admin', 'ADMIN', true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "role" = 'ADMIN');

-- Update existing records to have proper adminId
-- For users with role ADMIN, set adminId to their own id
UPDATE "users" SET "adminId" = "id" WHERE "role" = 'ADMIN';

-- For users with other roles, set adminId to their createdBy if it's an admin, otherwise to default admin
UPDATE "users"
SET "adminId" = COALESCE(
  (SELECT "id" FROM "users" u2 WHERE u2."id" = "users"."createdBy" AND u2."role" = 'ADMIN' LIMIT 1),
  'default-admin-id'
)
WHERE "role" != 'ADMIN';

-- For branches, set adminId to the user who created them (if available), otherwise default admin
UPDATE "branches"
SET "adminId" = COALESCE(
  (SELECT "createdBy"
   FROM "users"
   WHERE "users"."id" = "branches"."managerId"
   AND "users"."role" = 'ADMIN'
   LIMIT 1),
  'default-admin-id'
);

-- For other tables, set adminId to default admin for now
-- In production, you would want to properly map existing data to the correct admin
UPDATE "categories" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "suppliers" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "products" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "customers" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "sales" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "sale_items" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "receipts" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "refunds" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "refund_items" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;
UPDATE "stock_movements" SET "adminId" = 'default-admin-id' WHERE "adminId" IS NULL;

-- Add foreign key constraints
ALTER TABLE "users" ADD CONSTRAINT "users_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "branches" ADD CONSTRAINT "branches_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "categories" ADD CONSTRAINT "categories_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customers" ADD CONSTRAINT "customers_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales" ADD CONSTRAINT "sales_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add unique constraints for data isolation
ALTER TABLE "branches" ADD CONSTRAINT "branches_name_adminId_key" UNIQUE ("name", "adminId");
ALTER TABLE "categories" ADD CONSTRAINT "categories_name_adminId_key" UNIQUE ("name", "adminId");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_name_adminId_key" UNIQUE ("name", "adminId");
ALTER TABLE "products" ADD CONSTRAINT "products_sku_adminId_key" UNIQUE ("sku", "adminId");
ALTER TABLE "products" ADD CONSTRAINT "products_barcode_adminId_key" UNIQUE ("barcode", "adminId");
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_adminId_key" UNIQUE ("phone", "adminId");
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_receiptNumber_adminId_key" UNIQUE ("receiptNumber", "adminId");

-- Remove old unique constraints that are no longer needed
ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_name_key";
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_name_key";
ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "suppliers_name_key";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_sku_key";
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_barcode_key";
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_phone_key";
ALTER TABLE "receipts" DROP CONSTRAINT IF EXISTS "receipts_receiptNumber_key";

-- Make adminId NOT NULL for tables that require it (except users)
-- Only do this after we've set all existing records to have adminId values
ALTER TABLE "branches" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "categories" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "suppliers" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "sales" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "sale_items" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "receipts" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "refunds" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "refund_items" ALTER COLUMN "adminId" SET NOT NULL;
ALTER TABLE "stock_movements" ALTER COLUMN "adminId" SET NOT NULL;
