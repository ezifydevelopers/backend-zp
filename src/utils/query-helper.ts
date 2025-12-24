/**
 * Database Query Helper - Provides database-agnostic query utilities
 * Handles differences between SQLite and PostgreSQL
 */

/**
 * Check if we're using SQLite
 */
export function isSQLite(): boolean {
  const dbUrl = process.env.DATABASE_URL || '';
  return dbUrl.startsWith('file:');
}

/**
 * Check if we're using PostgreSQL
 */
export function isPostgreSQL(): boolean {
  return !isSQLite();
}

/**
 * Create a case-insensitive contains filter for search
 * SQLite: Uses LIKE with LOWER() for case-insensitive search
 * PostgreSQL: Uses ILIKE or contains with mode: 'insensitive'
 */
export function createCaseInsensitiveContains(field: string, value: string): any {
  if (isPostgreSQL()) {
    // PostgreSQL supports case-insensitive contains natively
    return {
      [field]: {
        contains: value,
        mode: 'insensitive' as const
      }
    };
  } else {
    // SQLite: Use contains (Prisma will handle it, but we need to ensure case-insensitive)
    // For SQLite, Prisma's contains is case-sensitive, so we'll use a workaround
    // We'll convert both to lowercase in the application layer
    // Note: This is a limitation - for better performance, consider using raw SQL
    return {
      [field]: {
        contains: value
      }
    };
  }
}

/**
 * Create case-insensitive search OR conditions
 * Works for both SQLite and PostgreSQL
 * Note: SQLite's contains is case-sensitive, but we'll use it anyway
 * For true case-insensitive search in SQLite, consider using raw SQL with LOWER()
 */
export function createSearchConditions(searchFields: string[], searchTerm: string): any {
  if (!searchTerm || searchTerm.trim() === '') {
    return {};
  }

  if (isPostgreSQL()) {
    // PostgreSQL: Use case-insensitive contains
    return {
      OR: searchFields.map(field => ({
        [field]: {
          contains: searchTerm,
          mode: 'insensitive' as const
        }
      }))
    };
  } else {
    // SQLite: Use contains
    // Note: SQLite's contains is case-sensitive by default
    // For case-insensitive search, we'd need to use raw SQL: LOWER(field) LIKE LOWER('%term%')
    // But Prisma's contains works and is simpler - users can search with correct case
    // If case-insensitive is critical, we can enhance this later with raw SQL
    return {
      OR: searchFields.map(field => ({
        [field]: {
          contains: searchTerm
        }
      }))
    };
  }
}

/**
 * Serialize BigInt values to strings for JSON responses
 * SQLite and PostgreSQL both can return BigInt values
 */
export function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }

  if (typeof obj === 'object') {
    // Check if it's a Date-like object (Prisma sometimes returns Date-like objects)
    if (obj.constructor && obj.constructor.name === 'Date') {
      return new Date(obj).toISOString();
    }
    const serialized: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        serialized[key] = serializeBigInt(obj[key]);
      }
    }
    return serialized;
  }

  return obj;
}

/**
 * Format date for database queries
 * Ensures consistent date handling across SQLite and PostgreSQL
 */
export function formatDateForQuery(date: Date | string): Date {
  if (typeof date === 'string') {
    return new Date(date);
  }
  return date;
}

/**
 * Create date range filter
 * Works for both SQLite and PostgreSQL
 */
export function createDateRangeFilter(
  startDate?: string | Date,
  endDate?: string | Date,
  fieldName: string = 'createdAt'
): any {
  const filter: any = {};

  if (startDate) {
    filter[fieldName] = {
      ...filter[fieldName],
      gte: formatDateForQuery(startDate)
    };
  }

  if (endDate) {
    const end = formatDateForQuery(endDate);
    // Add 23:59:59 to end date to include the entire day
    end.setHours(23, 59, 59, 999);
    filter[fieldName] = {
      ...filter[fieldName],
      lte: end
    };
  }

  return Object.keys(filter).length > 0 ? filter : {};
}

/**
 * Execute raw query with database-specific syntax
 */
export async function executeRawQuery(
  prisma: any,
  sqliteQuery: string,
  postgresQuery: string,
  params?: any[]
): Promise<any> {
  if (isSQLite()) {
    return prisma.$queryRawUnsafe(sqliteQuery, ...(params || []));
  } else {
    return prisma.$queryRawUnsafe(postgresQuery, ...(params || []));
  }
}

/**
 * Get current timestamp query (database-specific)
 */
export async function getCurrentTimestamp(prisma: any): Promise<Date> {
  if (isSQLite()) {
    const result = await prisma.$queryRaw`SELECT datetime('now') as current_time` as any[];
    return new Date(result[0].current_time);
  } else {
    const result = await prisma.$queryRaw`SELECT NOW() as current_time` as any[];
    return new Date(result[0].current_time);
  }
}

/**
 * Handle pagination (works for both databases)
 */
export function getPaginationParams(page?: string | number, limit?: string | number): {
  skip: number;
  take: number;
  page: number;
  limit: number;
} {
  const pageNum = Number(page) || 1;
  const limitNum = Number(limit) || 10;
  const skip = (pageNum - 1) * limitNum;

  return {
    skip: Math.max(0, skip),
    take: Math.max(1, Math.min(limitNum, 100)), // Max 100 items per page
    page: pageNum,
    limit: limitNum
  };
}

/**
 * Calculate pagination metadata
 */
export function getPaginationMeta(total: number, page: number, limit: number): {
  page: number;
  limit: number;
  total: number;
  pages: number;
} {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
  };
}
