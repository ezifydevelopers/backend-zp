-- Remove price and stock columns from products table
-- Prices and stock will now come from batches

-- Remove the columns
ALTER TABLE "products" DROP COLUMN IF EXISTS "costPrice";
ALTER TABLE "products" DROP COLUMN IF EXISTS "sellingPrice";
ALTER TABLE "products" DROP COLUMN IF EXISTS "stock";

