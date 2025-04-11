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
   * @param onChunk Optional callback for streaming chunks
   * @returns The generated completion response
   */
  public async generateChatCompletion(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    onChunk?: (chunk: string) => void
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

    // If streaming is requested via callback
    if (onChunk) {
      params.stream = true;

      try {
        const stream = await this.openai.chat.completions.create(params);
        let fullResponse: any = {
          choices: [{ message: { content: "", tool_calls: [] } }],
        };
        let accumulatedContent = "";
        let currentToolCalls: Array<any> = [];

        // Type assertion to work around TypeScript limitations with streaming
        // The OpenAI SDK actually returns a stream even though the type doesn't reflect it
        for await (const chunk of stream as any) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            accumulatedContent += content;
            onChunk(content);
          }

          // Handle tool calls in streaming
          if (chunk.choices[0]?.delta?.tool_calls) {
            const toolCallsDelta = chunk.choices[0].delta.tool_calls;

            for (const toolCallDelta of toolCallsDelta) {
              if (toolCallDelta.index === undefined) continue;

              // Initialize tool call at this index if it doesn't exist
              if (!currentToolCalls[toolCallDelta.index]) {
                currentToolCalls[toolCallDelta.index] = {
                  id: "",
                  type: "function",
                  function: {
                    name: "",
                    arguments: "",
                  },
                };
              }

              // Update ID if provided
              if (toolCallDelta.id) {
                currentToolCalls[toolCallDelta.index].id = toolCallDelta.id;
              }

              // Update function name if provided
              if (toolCallDelta.function?.name) {
                currentToolCalls[toolCallDelta.index].function.name =
                  toolCallDelta.function.name;
              }

              // Append to arguments if provided
              if (toolCallDelta.function?.arguments) {
                currentToolCalls[toolCallDelta.index].function.arguments +=
                  toolCallDelta.function.arguments;
              }
            }
          }
        }

        // Set the accumulated content and tool calls in the full response
        fullResponse.choices[0].message.content = accumulatedContent;
        if (currentToolCalls.length > 0) {
          fullResponse.choices[0].message.tool_calls = currentToolCalls;
        }

        return fullResponse;
      } catch (error) {
        console.error("Error in streaming completion:", error);
        // Fall back to non-streaming if streaming fails
        params.stream = false;
      }
    }

    // Non-streaming mode
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
