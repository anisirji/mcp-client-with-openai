import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// import { SseClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ChatCompletionTool } from "openai/resources/chat/completions";
import { Environment } from "../config/environment.js";
import {
  MCPServerConfig,
  MCPRequest,
  MCPToolResponse,
  MCPExecuteResponse,
} from "../types/index.js";

/**
 * Service for managing Model Context Protocol (MCP) connections
 */
export class MCPService {
  private static instance: MCPService;
  private env = Environment.getInstance();

  private mcpInstances: Record<string, Client> = {};
  private tools: Record<string, ChatCompletionTool[]> = {};

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): MCPService {
    if (!MCPService.instance) {
      MCPService.instance = new MCPService();
    }
    return MCPService.instance;
  }

  /**
   * Connect to all configured MCP servers
   */
  public async connectToServers(): Promise<void> {
    const connectionPromises = this.env.mcpServers.map((serverConfig) =>
      this.connectToServer(serverConfig)
    );

    try {
      await Promise.all(connectionPromises);
      console.log("✅ Connected to all MCP servers successfully");
    } catch (error) {
      console.error("❌ Failed to connect to some MCP servers:", error);
      // Continue even if some servers fail to connect
    }
  }

  /**
   * Connect to a specific MCP server
   * @param serverConfig Server configuration
   */
  private async connectToServer(serverConfig: MCPServerConfig): Promise<void> {
    try {
      // Create transport with options
      const transportConfig: any = {
        // Use process.execPath instead of serverConfig.command to ensure we use the correct Node executable
        command: process.execPath,
        args: serverConfig.args || [],
      };

      // Add environment variables if present in options
      if (serverConfig.options?.env) {
        transportConfig.env = Object.fromEntries(
          Object.entries(serverConfig.options.env).filter(
            ([, value]) => value !== undefined
          ) as [string, string][]
        );
      }

      // Add any other options
      if (serverConfig.options) {
        const { env, ...otherOptions } = serverConfig.options;
        Object.assign(transportConfig, otherOptions);
      }

      console.log(`Connecting to MCP server: ${serverConfig.name}`);

      // Create transport
      const transport = new StdioClientTransport(transportConfig);

      // Initialize client with transport
      const client = new Client({
        name: serverConfig.name,
        version: "1.0.0",
      });

      // Connect the client with transport
      await client.connect(transport);

      const serverName =
        serverConfig.name ||
        `server_${Object.keys(this.mcpInstances).length + 1}`;
      this.mcpInstances[serverName] = client;

      // Try different methods to get tools
      try {
        await this.discoverTools(client, serverName);
      } catch (toolError) {
        console.warn(`Error discovering tools from ${serverName}:`, toolError);
        console.warn(`Will proceed with empty tool list for ${serverName}`);
        // Initialize with empty tool list instead of failing
        this.tools[serverName] = [];
      }

      console.log(`Successfully connected to MCP server: ${serverName}`);
    } catch (error) {
      console.error(
        `Failed to connect to MCP server: ${serverConfig.name}`,
        error
      );
      throw error;
    }
  }

  /**
   * Try different methods to discover tools from a server
   * @param client The MCP client
   * @param serverName The server name
   */
  private async discoverTools(
    client: Client,
    serverName: string
  ): Promise<void> {
    // Try direct method first (from SDK)
    try {
      console.log(
        `Attempting to discover tools from ${serverName} using SDK methods`
      );
      const toolsResult = await client.listTools();

      if (toolsResult && toolsResult.tools) {
        this.tools[serverName] = toolsResult.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          },
        }));

        console.log(
          `Discovered ${this.tools[serverName].length} tools from MCP server: ${serverName}`
        );
        return;
      }
    } catch (error) {
      console.warn(
        `Standard listTools method failed for ${serverName}, trying alternatives`
      );
    }

    // First fallback: try using request with listTools method
    try {
      console.log(`Trying alternative discovery method for ${serverName}`);
      const listToolsRequest: MCPRequest = {
        method: "listTools",
      };

      const toolsResponse = (await (client as any).request(
        listToolsRequest
      )) as MCPToolResponse;

      if (toolsResponse.status === "success" && toolsResponse.tools) {
        this.processToolsResponse(toolsResponse, serverName);
        return;
      }
    } catch (error) {
      console.warn(`Alternative listTools method failed for ${serverName}`);
    }

    // Second fallback: try with getTools
    try {
      const getToolsRequest: MCPRequest = {
        method: "getTools",
      };

      const toolsResponse = (await (client as any).request(
        getToolsRequest
      )) as MCPToolResponse;

      if (toolsResponse.status === "success" && toolsResponse.tools) {
        this.processToolsResponse(toolsResponse, serverName);
        return;
      }
    } catch (error) {
      console.warn(`Alternative getTools method failed for ${serverName}`);
    }

    // If we get here, no tool discovery method worked
    this.tools[serverName] = [];
    console.warn(`No tools discovered for ${serverName}`);
  }

  /**
   * Process a tools response and format the tools
   * @param toolsResponse The tools response from the server
   * @param serverName The server name
   */
  private processToolsResponse(
    toolsResponse: MCPToolResponse,
    serverName: string
  ): void {
    // Ensure tools exist
    if (!toolsResponse.tools || toolsResponse.tools.length === 0) {
      this.tools[serverName] = [];
      console.log(`No tools available from MCP server: ${serverName}`);
      return;
    }

    // Convert the tools to the expected format with proper typing
    const formattedTools: ChatCompletionTool[] = toolsResponse.tools.map(
      (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: (tool as any).inputSchema || tool.parameters || {}, // Try inputSchema first, then fall back to parameters
        },
      })
    );

    this.tools[serverName] = formattedTools;
    console.log(
      `Discovered ${formattedTools.length} tools from MCP server: ${serverName}`
    );
  }

  /**
   * Execute a tool on an MCP server
   * @param serverName Name of the server
   * @param toolName Name of the tool to execute
   * @param args Arguments for the tool
   * @returns Result of tool execution
   */
  public async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (!this.mcpInstances[serverName]) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    try {
      // First try the direct SDK method
      try {
        console.log(
          `Executing tool ${toolName} on server ${serverName} using SDK method`
        );
        const result = await this.mcpInstances[serverName].callTool({
          name: toolName,
          arguments: args,
        });

        let toolResult: string;
        const content = result.content;
        if (Array.isArray(content) && content[0]?.type === "text") {
          toolResult = content.map((c) => c.text).join("\n");
        } else {
          toolResult =
            typeof content === "string" ? content : JSON.stringify(content);
        }

        return toolResult;
      } catch (error) {
        console.warn(
          `Direct callTool method failed for ${toolName}, trying alternatives`
        );
      }

      // First fallback: try the standard executeTool request method
      try {
        const executeRequest: MCPRequest = {
          method: "executeTool",
          params: {
            name: toolName,
            arguments: args,
          },
        };

        const response = (await (this.mcpInstances[serverName] as any).request(
          executeRequest
        )) as MCPExecuteResponse;

        if (response.status === "success") {
          return JSON.stringify(response.result);
        }
      } catch (error) {
        console.warn(
          `Standard executeTool method failed, trying alternatives for ${toolName}`
        );
      }

      // Second fallback: try alternative runTool method
      try {
        const runToolRequest: MCPRequest = {
          method: "runTool",
          params: {
            tool: toolName,
            args: args,
          },
        };

        const response = (await (this.mcpInstances[serverName] as any).request(
          runToolRequest
        )) as MCPExecuteResponse;

        if (response.status === "success") {
          return JSON.stringify(response.result);
        }
      } catch (error) {
        console.warn(`Alternative runTool method failed for ${toolName}`);
      }

      // If we get here, no execution method worked
      throw new Error(
        `Failed to execute tool ${toolName}: No supported execution method`
      );
    } catch (error) {
      console.error(
        `Failed to execute tool ${toolName} on server ${serverName}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get all available tools from all servers
   * @returns Combined list of all tools
   */
  public getAllTools(): ChatCompletionTool[] {
    return Object.values(this.tools).flat();
  }

  /**
   * Get tool description for all available tools
   * @returns Formatted string of tool descriptions
   */
  public getToolDescriptions(): string {
    return Object.entries(this.tools)
      .map(([serverName, tools]) => {
        return tools
          .map(
            (tool) =>
              `- ${tool.function.name}: ${
                tool.function.description || "No description provided"
              } (From server: ${serverName})`
          )
          .join("\n");
      })
      .join("\n");
  }

  /**
   * Find the server hosting a specific tool
   * @param toolName Name of the tool
   * @returns Server name or null if not found
   */
  public findServerForTool(toolName: string): string | null {
    for (const [serverName, tools] of Object.entries(this.tools)) {
      if (tools.some((tool) => tool.function.name === toolName)) {
        return serverName;
      }
    }
    return null;
  }
}
