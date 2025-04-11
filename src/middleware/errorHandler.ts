import { Request, Response, NextFunction } from "express";

/**
 * Global error handling middleware
 * @param err Error object
 * @param req Express Request object
 * @param res Express Response object
 * @param next Next function
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log the error
  console.error("Server error:", err);

  // Format the error response based on environment
  const formattedError = {
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  };

  // Send error response
  res.status(500).json({ error: formattedError });
}
