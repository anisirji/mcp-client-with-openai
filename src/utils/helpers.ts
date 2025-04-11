/**
 * Truncate a string result to a maximum number of lines
 * @param result String to truncate
 * @param maxLines Maximum number of lines to include
 * @returns Truncated string
 */
export function truncateResult(result: string, maxLines = 4): string {
  if (!result) return "";

  const lines = result.split("\n");
  if (lines.length <= maxLines) return result;

  const firstLines = lines.slice(0, maxLines).join("\n");
  return `${firstLines}\n...(${lines.length - maxLines} more lines)`;
}

/**
 * Generate a unique session ID
 * @returns Unique session ID string
 */
export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Extract session ID from request
 * @param queryParam Optional query parameter to check first
 * @param cookieHeader Optional cookie header to extract from
 * @returns Extracted or generated session ID
 */
export function extractSessionId(
  queryParam?: string,
  cookieHeader?: string
): string {
  if (queryParam) return queryParam;

  const cookieMatch = cookieHeader?.match(/session_id=([^;]+)/);
  if (cookieMatch?.[1]) return cookieMatch[1];

  return generateSessionId();
}

/**
 * Format error for consistent error handling
 * @param error Error object or string
 * @returns Formatted error object
 */
export function formatError(error: unknown): {
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

/**
 * Safe JSON parse with error handling
 * @param str String to parse
 * @param defaultValue Default value to return on error
 * @returns Parsed JSON or default value
 */
export function safeJsonParse<T>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str) as T;
  } catch (error) {
    console.error("JSON parse error:", error);
    return defaultValue;
  }
}
