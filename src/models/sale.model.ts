// Enums removed - using string types for SQLite compatibility
export type PaymentMethod = 'CASH' | 'CARD' | 'MOBILE' | 'BANK_TRANSFER';
export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
export type SaleStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED';

export interface CreateSaleData {
  customerId?: string;
  userId: string;
  branchId: string;
  items: SaleItemData[];
  paymentMethod: PaymentMethod | string;
  paymentStatus?: PaymentStatus | string;
  discountAmount?: number;
  discountPercentage?: number;
  saleDate?: string;
}

export interface SaleItemData {
  productId: string;
  quantity: number;
  unitPrice: number;
  batchId?: string; // Link to specific batch
  batchNumber?: string; // Keep for backward compatibility
  expiryDate?: string;
  discountPercentage?: number; // Item-level discount percentage
  discountAmount?: number; // Item-level discount amount
  totalPrice?: number; // Item total price after discount (optional, will be calculated if not provided)
}

export interface SaleResponse {
  id: string;
  customer?: {
    id: string;
    name: string;
    phone: string;
  };
  items: Array<{
    id: string;
    product: {
      id: string;
      name: string;
    };
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    batchNumber?: string;
    expiryDate?: string;
  }>;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  discountPercentage?: number;
  totalAmount: number;
  paymentMethod: PaymentMethod | string;
  paymentStatus: PaymentStatus | string;
  status: SaleStatus | string;
  saleDate?: string;
  createdAt: string;
  receiptNumber?: string;
}