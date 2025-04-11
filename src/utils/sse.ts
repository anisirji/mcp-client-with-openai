import { Response } from "express";
import { ActiveStream, SSEMessageHandler } from "../types/index.js";

/**
 * Configure SSE response headers
 * @param res Express response object
 */
export function configureSSEHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
}

/**
 * Create a keep-alive interval for SSE
 * @param res Express response object
 * @returns NodeJS.Timeout interval ID
 */
export function createSSEKeepAlive(res: Response): NodeJS.Timeout {
  return setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);
}

/**
 * Create an SSE message handler
 * @param res Express response object
 * @returns Message handler function
 */
export function createSSEMessageHandler(res: Response): SSEMessageHandler {
  return (role, content) => {
    const data = JSON.stringify({ role, content });
    res.write(`data: ${data}\n\n`);
  };
}

/**
 * Set up an active SSE stream
 * @param res Express response object
 * @returns Active stream object with response and ping interval
 */
export function setupSSEStream(res: Response): ActiveStream {
  configureSSEHeaders(res);
  const pingInterval = createSSEKeepAlive(res);

  // Clean up interval on connection close
  res.on("close", () => clearInterval(pingInterval));

  return {
    response: res,
    pingInterval,
  };
}

/**
 * Send error message through SSE
 * @param res Express response object
 * @param error Error to send
 */
export function sendSSEError(res: Response, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const data = JSON.stringify({
    role: "error",
    content: `Error: ${errorMessage}`,
  });
  res.write(`data: ${data}\n\n`);
  res.end();
}

/**
 * Safely end an SSE stream and clean up resources
 * @param stream Active stream to close
 */
export function closeSSEStream(stream: ActiveStream): void {
  clearInterval(stream.pingInterval);
  stream.response.end();
}
