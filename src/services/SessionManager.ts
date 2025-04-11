import { Environment } from "../config/environment.js";
import {
  ChatSession,
  ActiveStream,
  PendingToolExecution,
} from "../types/index.js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { closeSSEStream } from "../utils/sse.js";
import { Response } from "express";

/**
 * Service to manage user chat sessions and active SSE streams
 */
export class SessionManager {
  private static instance: SessionManager;
  private config = Environment.getInstance();

  private chatSessions: Map<string, ChatSession> = new Map();
  private activeStreams: Map<string, ActiveStream> = new Map();

  private constructor() {
    // Set up session cleanup interval
    setInterval(
      () => this.cleanupSessions(this.config.sessionTimeoutMs),
      this.config.sessionCleanupIntervalMs
    );
  }

  /**
   * Get the singleton instance of SessionManager
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Clean up inactive sessions
   * @param maxAge Maximum age of sessions to keep in milliseconds
   */
  private cleanupSessions(maxAge: number): void {
    const now = Date.now();

    for (const [sessionId, session] of this.chatSessions.entries()) {
      if (now - session.lastActivity > maxAge) {
        // Close any active streams for this session
        if (this.activeStreams.has(sessionId)) {
          closeSSEStream(this.activeStreams.get(sessionId)!);
          this.activeStreams.delete(sessionId);
        }

        // Delete the session
        this.chatSessions.delete(sessionId);
        console.log(`Cleaned up inactive session: ${sessionId}`);
      }
    }
  }

  /**
   * Get or create a chat session
   * @param sessionId Session ID
   * @param systemPrompt Optional system prompt to use for new sessions
   * @returns Chat session
   */
  public getOrCreateSession(
    sessionId: string,
    systemPrompt?: string
  ): ChatSession {
    if (!this.chatSessions.has(sessionId)) {
      this.chatSessions.set(sessionId, {
        messages: [
          {
            role: "system",
            content: systemPrompt || this.createDefaultSystemPrompt(sessionId),
          },
        ],
        lastActivity: Date.now(),
        pendingToolExecutions: new Map<string, PendingToolExecution>(),
        waitingForPermission: false,
      });
    }

    // Update last activity timestamp
    const session = this.chatSessions.get(sessionId)!;
    session.lastActivity = Date.now();

    return session;
  }

  /**
   * Create a default system prompt for new sessions
   * @param sessionId Session ID
   * @returns Default system prompt
   */
  private createDefaultSystemPrompt(sessionId: string): string {
    return `Session ID: ${sessionId}

You are a helpful and thoughtful AI assistant. There is no need to follow any strict step-by-step format.

Instead:
- Be friendly, natural, and conversational.
- Think carefully about what the user *really* wants before answering.
- Use your tools only when they genuinely help.
- Provide clear, useful answers, and explain your thinking if it adds value.
- Focus on understanding the user's goal and helping them achieve it efficiently.

Your goal is to make the user feel understood and supported. Keep the conversation natural and helpful.`;
  }

  /**
   * Track an active SSE response stream
   * @param sessionId Session ID
   * @param stream Active stream object
   */
  public trackStream(sessionId: string, stream: ActiveStream): void {
    // Close any existing stream for this session
    if (this.activeStreams.has(sessionId)) {
      closeSSEStream(this.activeStreams.get(sessionId)!);
    }

    this.activeStreams.set(sessionId, stream);

    // Clean up on disconnect
    stream.response.on("close", () => {
      this.activeStreams.delete(sessionId);
      console.log(`[SSE] Disconnected: ${sessionId}`);
    });
  }

  /**
   * Add a user message to a session
   * @param sessionId Session ID
   * @param message User message
   */
  public addUserMessage(sessionId: string, message: string): void {
    const session = this.getOrCreateSession(sessionId);

    // Check if this is a duplicate of the last message
    const lastMessage = session.messages[session.messages.length - 1];
    if (lastMessage?.role !== "user" || lastMessage?.content !== message) {
      session.messages.push({ role: "user", content: message });
    }
  }

  /**
   * Add an assistant message to a session
   * @param sessionId Session ID
   * @param message Assistant message
   * @returns The added message or null if session not found
   */
  public addAssistantMessage(
    sessionId: string,
    message: string
  ): ChatCompletionMessageParam | null {
    if (!this.chatSessions.has(sessionId)) {
      return null;
    }

    const newMessage: ChatCompletionMessageParam = {
      role: "assistant",
      content: message,
    };

    this.chatSessions.get(sessionId)!.messages.push(newMessage);
    this.chatSessions.get(sessionId)!.lastActivity = Date.now();

    return newMessage;
  }

  /**
   * Send a message to the client through an active SSE stream
   * @param sessionId Session ID
   * @param role Message role
   * @param content Message content
   * @returns Whether the message was sent
   */
  public pushMessageToClient(
    sessionId: string,
    role: string,
    content: string
  ): boolean {
    if (!this.activeStreams.has(sessionId)) {
      return false;
    }

    const stream = this.activeStreams.get(sessionId)!;
    stream.response.write(`data: ${JSON.stringify({ role, content })}\n\n`);

    return true;
  }

  /**
   * Clear a session
   * @param sessionId Session ID
   * @returns Whether the session was cleared
   */
  public clearSession(sessionId: string): boolean {
    if (!this.chatSessions.has(sessionId)) {
      return false;
    }

    this.chatSessions.delete(sessionId);

    // Also close any active stream
    if (this.activeStreams.has(sessionId)) {
      closeSSEStream(this.activeStreams.get(sessionId)!);
      this.activeStreams.delete(sessionId);
    }

    return true;
  }

  /**
   * Get all active sessions
   * @returns Map of all active sessions
   */
  public getAllSessions(): Map<string, ChatSession> {
    return this.chatSessions;
  }

  /**
   * Get a specific chat session
   * @param sessionId Session ID
   * @returns Chat session or undefined if not found
   */
  public getSession(sessionId: string): ChatSession | undefined {
    return this.chatSessions.get(sessionId);
  }

  /**
   * Check if a session exists
   * @param sessionId Session ID
   * @returns Whether the session exists
   */
  public hasSession(sessionId: string): boolean {
    return this.chatSessions.has(sessionId);
  }

  /**
   * Get an active stream for a session
   * @param sessionId Session ID
   * @returns Active stream or undefined if not found
   */
  public getActiveStream(sessionId: string): ActiveStream | undefined {
    return this.activeStreams.get(sessionId);
  }

  /**
   * Add a tool execution to pending queue
   * @param sessionId Session ID
   * @param toolExecution Tool execution details
   */
  public addPendingToolExecution(
    sessionId: string,
    toolExecution: PendingToolExecution
  ): void {
    const session = this.getOrCreateSession(sessionId);
    session.pendingToolExecutions.set(
      toolExecution.toolCall.id as string,
      toolExecution
    );
  }

  /**
   * Set the waiting for permission flag for a session
   * @param sessionId Session ID
   * @param waiting Whether the session is waiting for permission
   */
  public setWaitingForPermission(sessionId: string, waiting: boolean): void {
    const session = this.getOrCreateSession(sessionId);
    session.waitingForPermission = waiting;
  }
}
