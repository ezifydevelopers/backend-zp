// Environment variable type definitions
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      PORT: string;
      DATABASE_URL: string;
      JWT_SECRET: string;
      FRONTEND_URL?: string;
      CORS_ORIGINS?: string;
      RATE_LIMIT_WINDOW_MS?: string;
      RATE_LIMIT_MAX_REQUESTS?: string;
      MAX_FILE_SIZE?: string;
      ENABLE_REQUEST_LOGGING?: string;
      SYSTEM_EMAIL?: string;
      BRANCH_EMAIL?: string;
    }
  }
}

export {};
