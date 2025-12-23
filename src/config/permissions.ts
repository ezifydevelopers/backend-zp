// Role-based permissions configuration for Pharmacy POS
export interface Permission {
  resource: string;
  actions: string[];
  conditions?: {
    branchId?: boolean;
    ownData?: boolean;
    limit?: number;
  };
}

export interface RolePermissions {
  role: string;
  permissions: Permission[];
  description: string;
}

// Define all available resources and actions
export const RESOURCES = {
  // User Management
  USERS: 'users',
  EMPLOYEES: 'employees',
  BRANCHES: 'branches',

  // Inventory Management
  PRODUCTS: 'products',
  CATEGORIES: 'categories',
  SUPPLIERS: 'suppliers',
  STOCK_MOVEMENTS: 'stock_movements',

  // Sales & POS
  SALES: 'sales',
  RECEIPTS: 'receipts',
  REFUNDS: 'refunds',

  // Reports & Analytics
  REPORTS: 'reports',
  DASHBOARD: 'dashboard',
  ANALYTICS: 'analytics',

  // System Settings
  SETTINGS: 'settings',
  INTEGRATIONS: 'integrations',
  BACKUP: 'backup',

  // Pharmacy Specific
  PRESCRIPTIONS: 'prescriptions',
  CUSTOMERS: 'customers',
  MEDICATION_HISTORY: 'medication_history',

  // Shift Management
  SHIFTS: 'shifts',
  SCHEDULED_SHIFTS: 'scheduled_shifts',
  ATTENDANCE: 'attendance',

  // Financial
  COMMISSIONS: 'commissions',
  PAYMENTS: 'payments',
  BILLING: 'billing'
} as const;

export const ACTIONS = {
  CREATE: 'create',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
  APPROVE: 'approve',
  REJECT: 'reject',
  EXPORT: 'export',
  IMPORT: 'import',
  MANAGE: 'manage' // Full control
} as const;

// Role-based permissions configuration
export const ROLE_PERMISSIONS: RolePermissions[] = [
  {
    role: 'PRODUCT_OWNER',
    description: 'Product Owner / Subscription Admin - Full control of the POS product itself',
    permissions: [
      // System-wide management
      { resource: RESOURCES.USERS, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },
      { resource: RESOURCES.BRANCHES, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },
      { resource: RESOURCES.SETTINGS, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },
      { resource: RESOURCES.INTEGRATIONS, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },
      { resource: RESOURCES.BACKUP, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },
      { resource: RESOURCES.ANALYTICS, actions: [ACTIONS.READ], conditions: { branchId: false } },
      { resource: RESOURCES.BILLING, actions: [ACTIONS.MANAGE], conditions: { branchId: false } },

      // Cannot access day-to-day operations
      { resource: RESOURCES.PRODUCTS, actions: [], conditions: {} },
      { resource: RESOURCES.SALES, actions: [], conditions: {} },
      { resource: RESOURCES.PRESCRIPTIONS, actions: [], conditions: {} }
    ]
  },

  {
    role: 'SUPER_ADMIN',
    description: 'Super Admin - Full access across all branches of their pharmacy',
    permissions: [
      // Full system control
      { resource: RESOURCES.USERS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.EMPLOYEES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.BRANCHES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.PRODUCTS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.CATEGORIES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.SUPPLIERS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.SALES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.REPORTS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.DASHBOARD, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.SETTINGS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.INTEGRATIONS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.BACKUP, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.COMMISSIONS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.CUSTOMERS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.REFUNDS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } }
    ]
  },

  {
    role: 'MANAGER',
    description: 'Manager - Manages one store/branch operations',
    permissions: [
      // Branch-level management
      { resource: RESOURCES.USERS, actions: [ACTIONS.CREATE, ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.EMPLOYEES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.PRODUCTS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.CATEGORIES, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.SUPPLIERS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.SALES, actions: [ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.REPORTS, actions: [ACTIONS.READ, ACTIONS.EXPORT], conditions: { branchId: true } },
      { resource: RESOURCES.DASHBOARD, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.REFUNDS, actions: [ACTIONS.APPROVE, ACTIONS.REJECT], conditions: { branchId: true, limit: 1000 } },
      { resource: RESOURCES.CUSTOMERS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.COMMISSIONS, actions: [ACTIONS.READ], conditions: { branchId: true } },

      // Shift Management - Full access for managers
      { resource: RESOURCES.SHIFTS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.SCHEDULED_SHIFTS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.ATTENDANCE, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },

      // Cannot change global settings
      { resource: RESOURCES.SETTINGS, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.INTEGRATIONS, actions: [], conditions: {} },
      { resource: RESOURCES.BACKUP, actions: [], conditions: {} }
    ]
  },

  {
    role: 'PHARMACIST',
    description: 'Pharmacist - Ensures prescriptions and medicine sales are compliant',
    permissions: [
      // Prescription and medicine management
      { resource: RESOURCES.PRODUCTS, actions: [ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.PRESCRIPTIONS, actions: [ACTIONS.MANAGE], conditions: { branchId: true } },
      { resource: RESOURCES.CUSTOMERS, actions: [ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.MEDICATION_HISTORY, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.SALES, actions: [ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.STOCK_MOVEMENTS, actions: [ACTIONS.READ, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.DASHBOARD, actions: [ACTIONS.READ], conditions: { branchId: true } },

      // Limited access
      { resource: RESOURCES.REPORTS, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.CATEGORIES, actions: [ACTIONS.READ], conditions: { branchId: true } },

      // Cannot access finances or employee management
      { resource: RESOURCES.USERS, actions: [], conditions: {} },
      { resource: RESOURCES.EMPLOYEES, actions: [], conditions: {} },
      { resource: RESOURCES.COMMISSIONS, actions: [], conditions: {} },
      { resource: RESOURCES.SETTINGS, actions: [], conditions: {} }
    ]
  },

  {
    role: 'CASHIER',
    description: 'Cashier - Handles customer checkout and frontend sales',
    permissions: [
      // Sales and checkout operations
      { resource: RESOURCES.SALES, actions: [ACTIONS.CREATE, ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.RECEIPTS, actions: [ACTIONS.CREATE, ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.REFUNDS, actions: [ACTIONS.CREATE, ACTIONS.READ], conditions: { branchId: true, limit: 100 } },
      { resource: RESOURCES.PRODUCTS, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.CUSTOMERS, actions: [ACTIONS.READ, ACTIONS.CREATE, ACTIONS.UPDATE], conditions: { branchId: true } },
      { resource: RESOURCES.CATEGORIES, actions: [ACTIONS.READ], conditions: { branchId: true } },
      { resource: RESOURCES.DASHBOARD, actions: [ACTIONS.READ], conditions: { branchId: true } },

      // Very limited access
      { resource: RESOURCES.REPORTS, actions: [ACTIONS.READ], conditions: { branchId: true, ownData: true } },

      // Cannot edit inventory, manage users, or change settings
      { resource: RESOURCES.USERS, actions: [], conditions: {} },
      { resource: RESOURCES.EMPLOYEES, actions: [], conditions: {} },
      { resource: RESOURCES.SETTINGS, actions: [], conditions: {} },
      { resource: RESOURCES.SUPPLIERS, actions: [], conditions: {} },
      { resource: RESOURCES.STOCK_MOVEMENTS, actions: [], conditions: {} },
      { resource: RESOURCES.COMMISSIONS, actions: [], conditions: {} }
    ]
  }
];

// Helper function to get permissions for a role
export function getRolePermissions(role: string): Permission[] {
  const roleConfig = ROLE_PERMISSIONS.find(r => r.role === role);
  return roleConfig ? roleConfig.permissions : [];
}

// Helper function to check if user has permission
export function hasPermission(
  userRole: string,
  resource: string,
  action: string,
  userBranchId?: string,
  targetBranchId?: string,
  isOwnData: boolean = false
): boolean {
  const permissions = getRolePermissions(userRole);
  const permission = permissions.find(p => p.resource === resource);

  if (!permission) return false;
  if (!permission.actions.includes(action)) return false;

  // Check conditions
  if (permission.conditions) {
    const { branchId, ownData, limit } = permission.conditions;

    // Branch ID condition
    if (branchId === true && userBranchId && targetBranchId && userBranchId !== targetBranchId) {
      return false;
    }

    // Own data condition
    if (ownData === true && !isOwnData) {
      return false;
    }

    // Limit condition (for refunds, etc.)
    if (limit && action === ACTIONS.CREATE) {
      // This would need to be checked against actual data
      // For now, we'll assume it's allowed
    }
  }

  return true;
}

// Helper function to get accessible resources for a role
export function getAccessibleResources(role: string): string[] {
  const permissions = getRolePermissions(role);
  return permissions
    .filter(p => p.actions.length > 0)
    .map(p => p.resource);
}

// Helper function to get allowed actions for a resource and role
export function getAllowedActions(role: string, resource: string): string[] {
  const permissions = getRolePermissions(role);
  const permission = permissions.find(p => p.resource === resource);
  return permission ? permission.actions : [];
}
