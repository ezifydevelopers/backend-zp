


export interface CreateCustomerData {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    branchId: string;
  }
  
  export interface UpdateCustomerData {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    isVIP?: boolean;
    isActive?: boolean;
  }