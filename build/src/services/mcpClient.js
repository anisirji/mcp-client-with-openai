import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is not set in .env file");
// Load MCP config from the config folder
const configPath = path.join(process.cwd(), "config", "mcp-config.json");
if (!fs.existsSync(configPath))
    throw new Error(`Config file not found: ${configPath}`);
const mcpServers = JSON.parse(fs.readFileSync(configPath, "utf-8")).mcpServers;
export class MCPClient {
    mcpInstances = {};
    openai;
    tools = {};
    chatSessions = new Map();
    activeStreams = new Map();
    constructor() {
        this.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        // Clean up sessions every 5 minutes (remove inactive sessions after 30 minutes)
        setInterval(() => this.cleanupSessions(30 * 60 * 1000), 5 * 60 * 1000);
    }
    cleanupSessions(maxAge) {
        const now = Date.now();
        for (const [sessionId, session] of this.chatSessions.entries()) {
            if (now - session.lastActivity > maxAge) {
                this.chatSessions.delete(sessionId);
                console.log(`Cleaned up inactive session: ${sessionId}`);
            }
        }
    }
    getOrCreateSession(sessionId) {
        if (!this.chatSessions.has(sessionId)) {
            // Dynamically generate a string listing available tools
            const toolDescriptions = Object.entries(this.tools)
                .map(([serverName, tools]) => {
                return tools
                    .map((tool) => `- ${tool.function.name}: ${tool.function.description || "No description provided"} (From server: ${serverName})`)
                    .join("\n");
            })
                .join("\n");
            // Build the system prompt dynamically
            //       const systemPrompt = `Session ID: ${sessionId}
            //       You are a ReAct-style reasoning agent aware of your available tools. Always use the following format:
            // 1. Plan: Provide a concise, high-level plan for how you will solve the user's query.
            // 2. Thought: Then describe your detailed reasoning process.
            // 3. Action: Specify any tool to use along with its arguments (if needed).
            // 4. Observation: Record the result of the action/tool.
            // 5. Final Answer: Provide your final answer, preceded by "Final Answer:".
            // Important:
            // - Each step must be on its own line, labeled exactly (e.g., "Plan:", "Thought:", etc.).
            // - During Plan Phase no need to give Action, Ovservation, and FinalAns.
            // - Always provide a "Plan:" step before "Thought:".
            // - Always include the "Plan:" step in the response.
            // - Conclude with "Final Answer:" when done.
            // Available tools:
            // ${toolDescriptions}`;
            const systemPrompt = `Session ID: ${sessionId}

You are a helpful and thoughtful AI assistant. There is no need to follow any strict step-by-step format like "Plan", "Thought", "Action", etc.

Instead:
- Be friendly, natural, and conversational.
- Think carefully about what the user *really* wants before answering.
- Use your tools only when they genuinely help.
- Provide clear, useful answers, and explain your thinking if it adds value — but keep it human, not robotic.
- Focus on understanding the user's goal and helping them achieve it efficiently.

Available tools:
${toolDescriptions}

Your goal is to make the user feel understood and supported. Keep the conversation natural and helpful.`;
            this.chatSessions.set(sessionId, {
                messages: [
                    {
                        role: "system",
                        content: systemPrompt,
                    },
                ],
                lastActivity: Date.now(),
                pendingToolExecutions: new Map(),
                waitingForPermission: false,
            });
        }
        // Update last activity timestamp
        const session = this.chatSessions.get(sessionId);
        session.lastActivity = Date.now();
        return session;
    }
    async handleQuerySSE(query, sessionId, res) {
        const session = this.getOrCreateSession(sessionId);
        // First, check if this is a new query from the user
        const lastMessage = session.messages[session.messages.length - 1];
        if (lastMessage?.role !== "user" || lastMessage?.content !== query) {
            // Add the new user message if it doesn't match the last message
            session.messages.push({ role: "user", content: query });
        }
        const tools = Object.values(this.tools).flat();
        const maxSteps = 5; // Reduced from 10 to limit potential infinite loops
        // Set up SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        // Register this response stream
        this.activeStreams.set(sessionId, res);
        // Clean up on disconnect
        res.on("close", () => {
            this.activeStreams.delete(sessionId);
            console.log(`[SSE] Disconnected: ${sessionId}`);
        });
        // Optional: keep-alive ping every 15s
        const pingInterval = setInterval(() => {
            res.write(`: ping\n\n`);
        }, 15000);
        res.on("close", () => clearInterval(pingInterval));
        // Helper to send SSE messages
        const sendSSE = (role, content) => {
            const data = JSON.stringify({ role, content });
            res.write(`data: ${data}\n\n`);
        };
        // Clear any existing pending tool executions
        session.pendingToolExecutions.clear();
        session.waitingForPermission = false;
        // Track processed messages to detect loops
        const processedResponses = new Set();
        let shouldContinue = true;
        try {
            // Main reasoning loop
            for (let step = 0; step < maxSteps && shouldContinue; step++) {
                console.log(`[DEBUG] Step ${step} (${sessionId}) started`);
                // Skip generating a new response if we're waiting for permission
                if (session.waitingForPermission) {
                    console.log("[DEBUG] Waiting for permission, exiting loop");
                    break;
                }
                const response = await this.openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: session.messages,
                    tools,
                    max_tokens: 1000,
                });
                const resMsg = response.choices[0].message;
                console.log("[DEBUG] OpenAI response:", resMsg);
                // Create a hash of the response to detect duplicates
                const responseHash = JSON.stringify({
                    content: resMsg.content,
                    tool_calls: resMsg.tool_calls,
                });
                // Check if we've seen this exact response before (detect loops)
                if (processedResponses.has(responseHash)) {
                    console.log("[DEBUG] Detected duplicate response, breaking loop");
                    shouldContinue = false;
                    break;
                }
                // Mark this response as processed
                processedResponses.add(responseHash);
                if (resMsg.content) {
                    // Add the response to the session
                    session.messages.push({ role: "assistant", content: resMsg.content });
                    // Send to client
                    sendSSE("assistant", resMsg.content);
                    // Check if this looks like a final answer
                    if (!resMsg.tool_calls || resMsg.tool_calls.length === 0) {
                        // If no tool calls, we can end the conversation
                        shouldContinue = false;
                    }
                }
                const toolCalls = resMsg.tool_calls;
                if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                    session.messages.push({
                        role: "assistant",
                        content: resMsg.content || "",
                        tool_calls: toolCalls,
                    });
                    // Prepare permission request for the tools
                    for (const toolCall of toolCalls) {
                        const toolName = toolCall.function?.name;
                        const args = toolCall.function?.arguments
                            ? JSON.parse(toolCall.function.arguments)
                            : {};
                        session.pendingToolExecutions.set(toolCall.id, {
                            toolName,
                            args,
                            toolCall,
                        });
                    }
                    // Ask for permission
                    const toolNames = [...session.pendingToolExecutions.values()]
                        .map((t) => t.toolName)
                        .join(", ");
                    sendSSE("permission", `Do you want to allow execution of the following tools: ${toolNames}?`);
                    session.waitingForPermission = true;
                    // Exit the loop and wait for permission
                    break;
                }
            }
            if (!session.waitingForPermission) {
                sendSSE("info", "Done");
                res.end(); // Explicitly end the connection if not waiting for permission
            }
        }
        catch (err) {
            console.error("Error in chat completion:", err);
            sendSSE("error", "Error processing your request");
            res.end();
        }
    }
    async handleToolPermission(sessionId, permissionGranted) {
        const res = this.activeStreams.get(sessionId);
        if (!res)
            return;
        const session = this.chatSessions.get(sessionId);
        if (!session)
            return;
        // Helper to send SSE messages
        const sendSSE = (role, content) => {
            const data = JSON.stringify({ role, content });
            res.write(`data: ${data}\n\n`);
        };
        try {
            if (permissionGranted) {
                sendSSE("info", "Tool execution permitted. Proceeding...");
                // Execute each pending tool
                for (const [id, toolExecution,] of session.pendingToolExecutions.entries()) {
                    const { toolName, args, toolCall } = toolExecution;
                    let executed = false;
                    for (const [serverName, mcpInstance] of Object.entries(this.mcpInstances)) {
                        try {
                            const result = await mcpInstance.callTool({
                                name: toolName,
                                arguments: args,
                            });
                            let toolResult;
                            const content = result.content;
                            if (Array.isArray(content) && content[0]?.type === "text") {
                                toolResult = content.map((c) => c.text).join("\n");
                            }
                            else {
                                toolResult =
                                    typeof content === "string"
                                        ? content
                                        : JSON.stringify(content);
                            }
                            session.messages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: toolResult,
                            });
                            function truncateToolResult(result, maxLines = 4) {
                                const lines = result.split("\n");
                                if (lines.length <= maxLines) {
                                    return result;
                                }
                                return lines.slice(0, maxLines).join("\n") + "\n...";
                            }
                            sendSSE("assistant", `Observation: ${truncateToolResult(toolResult)}`);
                            executed = true;
                            break;
                        }
                        catch (err) {
                            console.error(`[DEBUG] Tool "${toolName}" failed:`, err);
                        }
                    }
                    if (!executed) {
                        const failMsg = `❌ Tool ${toolName} failed.`;
                        session.messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: JSON.stringify({ error: failMsg }),
                        });
                        sendSSE("assistant", `Observation: ${failMsg}`);
                    }
                }
                // Clear pending tools
                session.pendingToolExecutions.clear();
                session.waitingForPermission = false;
                // Continue the conversation with one final response
                await this.continueConversation(sessionId);
            }
            else {
                sendSSE("info", "Tool execution denied. Cancelling operation.");
                // Add a message to inform the AI that the user denied permission
                session.messages.push({
                    role: "system",
                    content: "The user denied permission to execute the requested tools. Please provide an alternative solution or ask if they need help with something else.",
                });
                // Clear pending tools
                session.pendingToolExecutions.clear();
                session.waitingForPermission = false;
                // Continue the conversation with one final response
                await this.continueConversation(sessionId);
            }
            // We don't end the response here because continueConversation will do it
        }
        catch (err) {
            console.error("Error in tool permission handling:", err);
            sendSSE("error", "Error processing tool permission");
            res.end();
        }
    }
    async continueConversation(sessionId) {
        const res = this.activeStreams.get(sessionId);
        if (!res)
            return;
        const session = this.chatSessions.get(sessionId);
        if (!session)
            return;
        // Helper to send SSE messages
        const sendSSE = (role, content) => {
            const data = JSON.stringify({ role, content });
            res.write(`data: ${data}\n\n`);
        };
        try {
            const tools = Object.values(this.tools).flat();
            const response = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: session.messages,
                tools,
                max_tokens: 1000,
            });
            const resMsg = response.choices[0].message;
            if (resMsg.content) {
                // Add the response to the session
                session.messages.push({ role: "assistant", content: resMsg.content });
                // Send to client
                sendSSE("assistant", resMsg.content);
            }
            sendSSE("info", "Done");
            res.end(); // Always end the response
        }
        catch (err) {
            console.error("Error in continuing conversation:", err);
            sendSSE("error", "Error continuing conversation");
            res.end();
        }
    }
    // Connect to all configured MCP servers
    async connectToServers() {
        for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
            try {
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    args: serverConfig.args,
                    env: serverConfig.env
                        ? Object.fromEntries(Object.entries(serverConfig.env).filter(([, value]) => value !== undefined))
                        : undefined,
                });
                const mcpInstance = new Client({ name: serverName, version: "1.0.0" });
                mcpInstance.connect(transport);
                this.mcpInstances[serverName] = mcpInstance;
                const toolsResult = await mcpInstance.listTools();
                this.tools[serverName] = toolsResult.tools.map((tool) => ({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description ?? "",
                        parameters: tool.inputSchema,
                    },
                }));
            }
            catch (e) {
                console.error(`Failed to connect to MCP server (${serverName}):`, e);
            }
        }
    }
    injectAssistantMessage(sessionId, content) {
        const session = this.chatSessions.get(sessionId);
        if (!session)
            return null;
        const message = {
            role: "assistant",
            content,
        };
        session.messages.push(message);
        session.lastActivity = Date.now();
        console.log(`[Injected] Message into session ${sessionId}:`, content);
        return message;
    }
    pushMessageToClient(sessionId, role, content) {
        const stream = this.activeStreams.get(sessionId);
        if (!stream)
            return false;
        const data = JSON.stringify({ role, content });
        stream.write(`data: ${data}\n\n`);
        return true;
    }
    // Optionally clear a session
    clearSession(sessionId) {
        return this.chatSessions.delete(sessionId);
    }
}
