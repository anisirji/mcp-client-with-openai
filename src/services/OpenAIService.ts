import OpenAI from "openai";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { Environment } from "../config/environment.js";
import { truncateResult } from "../utils/helpers.js";

/**
 * Service for managing OpenAI API interactions
 */
export class OpenAIService {
  private static instance: OpenAIService;
  private config = Environment.getInstance();
  private openai: OpenAI;

  private constructor() {
    this.openai = new OpenAI({ apiKey: this.config.openaiApiKey });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): OpenAIService {
    if (!OpenAIService.instance) {
      OpenAIService.instance = new OpenAIService();
    }
    return OpenAIService.instance;
  }

  /**
   * Generate a chat completion
   * @param messages Chat messages history
   * @param tools Available tools
   * @returns The generated completion response
   */
  public async generateChatCompletion(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[]
  ) {
    // Log message history for debugging
    console.log(
      `[OpenAI] Generating completion with ${messages.length} messages`
    );

    // Only include tools parameter if tools are available
    const params: any = {
      model: this.config.defaultLLMModel,
      messages,
      max_tokens: 1000,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    return this.openai.chat.completions.create(params);
  }

  /**
   * Process tool call results into assistant message format
   * @param toolCall The tool call object
   * @param result Result from tool execution
   * @returns Formatted tool call with result
   */
  public formatToolCallResult(toolCall: any, result: string): any {
    // Truncate long results for readability
    const truncatedResult = truncateResult(result);

    return {
      tool_call_id: toolCall.id,
      role: "tool" as const,
      name: toolCall.function.name,
      content: truncatedResult,
    };
  }

  /**
   * Format an error into an assistant message
   * @param error Error to format
   * @returns Formatted error message
   */
  public formatErrorMessage(error: unknown): ChatCompletionMessageParam {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      role: "assistant",
      content: `I encountered an error: ${errorMessage}\n\nPlease try again or ask a different question.`,
    };
  }

  /**
   * Check if a completion response contains tool calls
   * @param response The completion response
   * @returns Whether the response has tool calls
   */
  public hasToolCalls(response: any): boolean {
    return response?.choices?.[0]?.message?.tool_calls?.length > 0;
  }

  /**
   * Extract content from a completion response
   * @param response The completion response
   * @returns The content string
   */
  public extractContent(response: any): string {
    return response?.choices?.[0]?.message?.content || "";
  }

  /**
   * Extract tool calls from a completion response
   * @param response The completion response
   * @returns Array of tool calls or undefined if none
   */
  public extractToolCalls(response: any): any[] | undefined {
    const toolCalls = response?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(toolCalls) && toolCalls.length > 0
      ? toolCalls
      : undefined;
  }
}
