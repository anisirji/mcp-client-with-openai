import { Response } from "express";
import { MCPService } from "../services/MCPService.js";
import { OpenAIService } from "../services/OpenAIService.js";
import { SessionManager } from "../services/SessionManager.js";
import { PendingToolExecution } from "../types/index.js";
import {
  setupSSEStream,
  sendSSEError,
  createSSEMessageHandler,
} from "../utils/sse.js";
import { Environment } from "../config/environment.js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Controller responsible for handling conversation logic
 */
export class ConversationController {
  private static instance: ConversationController;
  private config = Environment.getInstance();
  private sessionManager = SessionManager.getInstance();
  private mcpService = MCPService.getInstance();
  private openAIService = OpenAIService.getInstance();

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): ConversationController {
    if (!ConversationController.instance) {
      ConversationController.instance = new ConversationController();
    }
    return ConversationController.instance;
  }

  /**
   * Handle an SSE query
   * @param query User query text
   * @param sessionId Session ID
   * @param res Express response object
   */
  public async handleQuerySSE(
    query: string,
    sessionId: string,
    res: Response
  ): Promise<void> {
    // Set up SSE connection
    const stream = setupSSEStream(res);
    this.sessionManager.trackStream(sessionId, stream);

    // Add the user message to the session
    this.sessionManager.addUserMessage(sessionId, query);

    // Get the session
    const session = this.sessionManager.getOrCreateSession(sessionId);

    // Clear any existing pending tool executions
    session.pendingToolExecutions.clear();
    session.waitingForPermission = false;

    // Create a helper for sending SSE messages
    const sendSSE = createSSEMessageHandler(res);

    try {
      await this.processConversation(sessionId, sendSSE);
    } catch (error) {
      console.error("Error processing conversation:", error);
      sendSSEError(res, error);
    }
  }

  /**
   * Process conversation with reasoning loop
   * @param sessionId Session ID
   * @param sendSSE Function to send SSE messages
   */
  private async processConversation(
    sessionId: string,
    sendSSE: (role: string, content: string) => void
  ): Promise<void> {
    const session = this.sessionManager.getOrCreateSession(sessionId);
    const tools = this.mcpService.getAllTools();

    console.info(
      "\n\nSession:",
      session,
      "\nTools inside processConversation:",
      tools,
      "\n\n\n"
    );

    // Set limit for conversation steps to prevent infinite loops
    const maxSteps = this.config.maxSteps;
    let shouldContinue = true;

    // Track processed responses to detect loops
    const processedResponses = new Set<string>();

    // Main reasoning loop
    for (let step = 0; step < maxSteps && shouldContinue; step++) {
      console.log(`[DEBUG] Conversation step ${step} (${sessionId}) started`);

      console.info(
        "\n\nSession:",
        session,
        "\nInside Main Reasoning Loop",
        tools,
        "\n\n\n"
      );

      // Skip generating a new response if we're waiting for permission
      if (session.waitingForPermission) {
        console.info("\n\nI am waiting for permission, exiting loop\n\n");
        break;
      }

      console.info(
        "\n\nGenerating a new response from the AI -- > no need of permission\n\n"
      );

      // Generate a new response from the AI
      try {
        const response = await this.openAIService.generateChatCompletion(
          session.messages,
          tools.length > 0 ? tools : undefined
        );

        // Extract the content and tool calls
        const content = this.openAIService.extractContent(response);
        const toolCalls = this.openAIService.extractToolCalls(response);

        console.log(
          "[DEBUG] OpenAI response:",
          JSON.stringify({
            content,
            tool_calls: toolCalls ? toolCalls.length : 0,
          })
        );

        // Add the assistant's response to the conversation
        const assistantMessage: ChatCompletionMessageParam = {
          role: "assistant",
          content: content,
        };

        // Only add tool_calls if they exist and are not empty
        if (toolCalls && toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }

        session.messages.push(assistantMessage);

        // Send the response to the client
        sendSSE("assistant", content);

        // Check for response cycles to prevent infinite loops
        if (processedResponses.has(content)) {
          console.log("[DEBUG] Detected conversation loop, breaking");
          break;
        }
        processedResponses.add(content);

        // Check if the AI is trying to use tools
        if (this.openAIService.hasToolCalls(response)) {
          shouldContinue = await this.handleToolCalls(
            sessionId,
            this.openAIService.extractToolCalls(response),
            sendSSE
          );
        } else {
          // No tool calls, we're done
          shouldContinue = false;
        }
      } catch (error) {
        console.error(`Error in conversation step ${step}:`, error);
        sendSSE(
          "error",
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );

        // Add error message to the conversation
        session.messages.push(this.openAIService.formatErrorMessage(error));
        shouldContinue = false;
      }
    }
  }

  /**
   * Handle tool calls from the AI
   * @param sessionId Session ID
   * @param toolCalls Tool calls to process
   * @param sendSSE Function to send SSE messages
   * @returns Whether to continue the conversation
   */
  private async handleToolCalls(
    sessionId: string,
    toolCalls: any[] | undefined,
    sendSSE: (role: string, content: string) => void
  ): Promise<boolean> {
    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls, don't continue the conversation
      return false;
    }

    const session = this.sessionManager.getOrCreateSession(sessionId);

    // Track valid tool names for permission request
    const validToolNames: string[] = [];

    // Process all tool calls
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      let args: any;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error) {
        console.error(`Failed to parse tool arguments for ${toolName}:`, error);
        args = {};
      }

      // Find the server that hosts this tool
      const serverName = this.mcpService.findServerForTool(toolName);

      if (!serverName) {
        console.error(`Tool ${toolName} not found on any server`);
        const errorMessage = `Tool '${toolName}' is not available.`;
        session.messages.push(
          this.openAIService.formatToolCallResult(toolCall, errorMessage)
        );
        sendSSE("tool", `Tool '${toolName}' failed: ${errorMessage}`);
        continue;
      }

      // Store pending tool execution
      const pendingExecution: PendingToolExecution = {
        toolName,
        args,
        toolCall,
      };

      session.pendingToolExecutions.set(toolCall.id, pendingExecution);
      validToolNames.push(toolName);
    }

    // If we have valid tools that need permission
    if (validToolNames.length > 0) {
      session.waitingForPermission = true;

      // Format the permission message based on number of tools
      let permissionMessage = "";
      if (validToolNames.length === 1) {
        permissionMessage = `Do you want to allow execution of tool: ${validToolNames[0]}?`;
      } else {
        permissionMessage = `Do you want to allow execution of these tools: ${validToolNames.join(
          ", "
        )}?`;
      }

      // Notify the client that we need permission
      sendSSE("permission", permissionMessage);

      // Return true to indicate we are waiting for permission
      return true;
    }

    // If we processed all tool calls without any valid ones,
    // we can continue the conversation
    return false;
  }

  /**
   * Handle tool permission response
   * @param sessionId Session ID
   * @param permissionGranted Whether permission was granted
   */
  public async handleToolPermission(
    sessionId: string,
    permissionGranted: boolean
  ): Promise<void> {
    const session = this.sessionManager.getOrCreateSession(sessionId);
    const activeStream = this.sessionManager.getActiveStream(sessionId);

    if (!activeStream) {
      console.error(`No active stream found for session ${sessionId}`);
      return;
    }

    // Create a helper for sending SSE messages
    const sendSSE = createSSEMessageHandler(activeStream.response);

    // Reset waiting for permission flag
    session.waitingForPermission = false;

    if (!permissionGranted) {
      sendSSE("assistant", "I'll respect your decision not to use that tool.");

      // Add a message to the conversation
      session.messages.push({
        role: "assistant",
        content: "I'll respect your decision not to use that tool.",
      });

      // Clear pending tool executions
      session.pendingToolExecutions.clear();

      // Continue the conversation
      await this.processConversation(sessionId, sendSSE);
      return;
    }

    // Permission was granted, execute all pending tool calls
    for (const [
      toolCallId,
      pendingExecution,
    ] of session.pendingToolExecutions) {
      const { toolName, args, toolCall } = pendingExecution;

      // Find the server for this tool
      const serverName = this.mcpService.findServerForTool(toolName);

      if (!serverName) {
        console.error(`Tool ${toolName} not found on any server`);
        const errorMessage = `Tool '${toolName}' is not available.`;
        session.messages.push(
          this.openAIService.formatToolCallResult(toolCall, errorMessage)
        );
        sendSSE("tool", `Tool '${toolName}' failed: ${errorMessage}`);
        continue;
      }

      try {
        // Execute the tool
        sendSSE("tool-executing", `Executing tool: ${toolName}`);

        const result = await this.mcpService.executeTool(
          serverName,
          toolName,
          args
        );

        // Format and add the result to the conversation
        const formattedResult = this.openAIService.formatToolCallResult(
          toolCall,
          result
        );
        session.messages.push(formattedResult);

        // Send the result to the client
        sendSSE(
          "tool",
          `Tool '${toolName}' result: ${formattedResult.content}`
        );
      } catch (error) {
        console.error(`Error executing tool ${toolName}:`, error);

        // Format and add the error to the conversation
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        session.messages.push(
          this.openAIService.formatToolCallResult(
            toolCall,
            `Error: ${errorMessage}`
          )
        );

        // Send the error to the client
        sendSSE("tool", `Tool '${toolName}' failed: ${errorMessage}`);
      }
    }

    // Clear pending tool executions
    session.pendingToolExecutions.clear();

    // Continue the conversation
    await this.processConversation(sessionId, sendSSE);
  }

  /**
   * Inject an assistant message into the conversation
   * @param sessionId Session ID
   * @param content Message content
   * @returns The injected message or null if the session does not exist
   */
  public injectAssistantMessage(sessionId: string, content: string) {
    return this.sessionManager.addAssistantMessage(sessionId, content);
  }

  /**
   * Push a message to an active client stream
   * @param sessionId Session ID
   * @param role Message role
   * @param content Message content
   * @returns Whether the message was sent
   */
  public pushMessageToClient(sessionId: string, role: string, content: string) {
    return this.sessionManager.pushMessageToClient(sessionId, role, content);
  }

  /**
   * Clear a session
   * @param sessionId Session ID
   * @returns Whether the session was cleared
   */
  public clearSession(sessionId: string) {
    return this.sessionManager.clearSession(sessionId);
  }
}
