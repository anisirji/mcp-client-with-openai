import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { Response } from "express";

/**
 * Interface representing a pending tool execution
 */
export interface PendingToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  toolCall: Record<string, unknown>;
}

/**
 * Interface representing a chat session with its state
 */
export interface ChatSession {
  messages: ChatCompletionMessageParam[];
  lastActivity: number;
  pendingToolExecutions: Map<string, PendingToolExecution>;
  waitingForPermission: boolean;
}

/**
 * Configuration for MCP servers
 */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  options?: {
    env?: Record<string, string>;
    cwd?: string;
    [key: string]: any;
  };
}

/**
 * Configuration object shape
 */
export interface Config {
  mcpServers: MCPServerConfig[];
}

/**
 * Stream event handler function type
 */
export type SSEMessageHandler = (
  role:
    | "assistant"
    | "assistant-chunk"
    | "assistant-complete"
    | "info"
    | "error"
    | "tool"
    | "tool-executing"
    | "permission",
  content: string
) => void;

/**
 * Session stream tracking interface
 */
export interface ActiveStream {
  response: Response;
  pingInterval: NodeJS.Timeout;
}

/**
 * MCP tool response schema
 */
export interface MCPToolResponse {
  status: string;
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  error?: {
    message: string;
  };
}

/**
 * MCP execute response schema
 */
export interface MCPExecuteResponse {
  status: string;
  result?: unknown;
  error?: {
    message: string;
  };
}

/**
 * MCP request format
 */
export interface MCPRequest {
  method: string;
  params?: Record<string, unknown>;
}
