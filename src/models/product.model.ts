


export interface CreateProductData {
    name: string;
    description?: string;
    formula?: string; // New field for product composition
    sku: string;
    categoryId: string;
    categoryName?: string; // For bulk import - category name when categoryId doesn't exist
    supplierId?: string; // Optional - supplier is assigned at batch level
    branchId: string;
    barcode?: string;
    requiresPrescription: boolean;
    // Temporary fields for backward compatibility (will be removed when frontend is updated)
    costPrice?: number;
    sellingPrice?: number;
    stock?: number;
    minStock?: number;
    maxStock?: bigint;
    unitsPerPack?: number;
  }

  export interface UpdateProductData {
    name?: string;
    description?: string;
    formula?: string; // New field for product composition
    sku?: string;
    categoryId?: string;
    supplierId?: string;
    branchId?: string;
    barcode?: string;
    requiresPrescription?: boolean;
    isActive?: boolean;
    // Temporary fields for backward compatibility (will be removed when frontend is updated)
    costPrice?: number;
    sellingPrice?: number;
    stock?: number;
    minStock?: number;
    maxStock?: bigint;
    unitsPerPack?: number;
  }

  export interface StockMovementData {
    productId: string;
    type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN';
    quantity: number;
    reason?: string;
    reference?: string;
    createdBy?: string;
  }