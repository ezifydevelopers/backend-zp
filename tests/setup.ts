/**
 * Jest Test Setup
 */

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:./test.db';
process.env.REMOTE_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

// Increase timeout for async operations
jest.setTimeout(30000);

// Cleanup after all tests
afterAll(async () => {
  // Cleanup code if needed
});
