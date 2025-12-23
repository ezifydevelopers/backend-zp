import { Request, Response, NextFunction } from 'express';

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  // Don't log errors for favicon or common browser requests
  const shouldLog = !req.originalUrl.includes('favicon.ico') &&
                    !req.originalUrl.includes('robots.txt') &&
                    req.method !== 'OPTIONS';

  if (shouldLog) {
    console.warn(`404 - Not Found: ${req.method} ${req.originalUrl}`);
  }

  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};