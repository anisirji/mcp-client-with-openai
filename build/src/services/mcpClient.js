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
            const systemPrompt = `Session ID: ${sessionId}
      
      You are a ReAct-style reasoning agent aware of your available tools. Always use the following format:
1. Plan: Provide a concise, high-level plan for how you will solve the user's query.
2. Thought: Then describe your detailed reasoning process.
3. Action: Specify any tool to use along with its arguments (if needed).
4. Observation: Record the result of the action/tool.
5. Final Answer: Provide your final answer, preceded by "Final Answer:".

Important:
- Each step must be on its own line, labeled exactly (e.g., "Plan:", "Thought:", etc.).
- During Plan Phase no need to give Action, Ovservation, and FinalAns. 
- Always provide a "Plan:" step before "Thought:".
- Always include the "Plan:" step in the response.
- Conclude with "Final Answer:" when done.

Available tools:
${toolDescriptions}`;
            this.chatSessions.set(sessionId, {
                messages: [
                    {
                        role: "system",
                        content: systemPrompt,
                    },
                ],
                lastActivity: Date.now(),
            });
        }
        // Update last activity timestamp
        const session = this.chatSessions.get(sessionId);
        session.lastActivity = Date.now();
        return session;
    }
    // SSE-based method for handling queries with a preliminary planning phase
    async handleQuerySSE(query, sessionId, res) {
        const session = this.getOrCreateSession(sessionId);
        session.messages.push({ role: "user", content: query });
        const tools = Object.values(this.tools).flat();
        const maxSteps = 10;
        let finalAnswer = "";
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
        function sendSSE(role, content) {
            const data = JSON.stringify({ role, content });
            res.write(`data: ${data}\n\n`);
        }
        // Notify frontend that the chain-of-thought is starting
        sendSSE("info", "Starting chain-of-thought...");
        // ---------- Planning Phase ---------- //
        try {
            const preliminaryResponse = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: session.messages,
                max_tokens: 1000,
            });
            const preliminaryMsg = preliminaryResponse.choices[0].message;
            if (preliminaryMsg.content) {
                const planSteps = preliminaryMsg.content
                    .split(/\n(?=Plan:)/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (planSteps.length > 0) {
                    const planStep = planSteps[0];
                    session.messages.push({ role: "assistant", content: planStep });
                    sendSSE("assistant", planStep);
                }
            }
        }
        catch (err) {
            console.error("Error in planning phase:", err);
            sendSSE("error", "Error in planning phase");
            res.end();
            return;
        }
        // ---------- ReAct Loop ---------- //
        for (let step = 0; step < maxSteps; step++) {
            console.log(`[DEBUG] Step ${step} (${sessionId}) messages:`, session.messages);
            const response = await this.openai.chat.completions.create({
                model: "gpt-4o",
                messages: session.messages,
                tools,
                max_tokens: 1000,
            });
            const resMsg = response.choices[0].message;
            console.log("[DEBUG] OpenAI response:", resMsg);
            if (resMsg.content) {
                const steps = resMsg.content
                    .split(/\n(?=Plan:|Thought:|Action:|Observation:|Final Answer:)/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                let foundFinal = false;
                for (const stepContent of steps) {
                    session.messages.push({ role: "assistant", content: stepContent });
                    sendSSE("assistant", stepContent);
                    if (/^Final Answer\s*:/i.test(stepContent)) {
                        finalAnswer = stepContent;
                        foundFinal = true;
                        break;
                    }
                }
                if (foundFinal)
                    break;
            }
            const toolCalls = resMsg.tool_calls;
            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                session.messages.push({
                    role: "assistant",
                    content: resMsg.content || "",
                    tool_calls: toolCalls,
                });
                for (const toolCall of toolCalls) {
                    const toolName = toolCall.function?.name;
                    const args = toolCall.function?.arguments
                        ? JSON.parse(toolCall.function.arguments)
                        : {};
                    console.log(`[DEBUG] Tool call "${toolName}" with args:`, args);
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
                            sendSSE("assistant", `Observation: ${toolResult}`);
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
                continue; // restart loop
            }
            if (!finalAnswer)
                finalAnswer = resMsg.content || "No Answer";
            break;
        }
        sendSSE("info", "Done");
        // res.end();
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
