import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { Config, MCPServerConfig } from "../types/index.js";

// Load environment variables
dotenv.config();

/**
 * Environment configuration class to manage all app configuration
 */
export class Environment {
  private static instance: Environment;

  // Environment variables
  readonly port: number;
  readonly openaiApiKey: string;
  readonly configPath: string;
  readonly mcpServers: MCPServerConfig[];
  readonly sessionTimeoutMs: number = 30 * 60 * 1000; // 30 minutes
  readonly sessionCleanupIntervalMs: number = 5 * 60 * 1000; // 5 minutes
  readonly maxSteps: number = 5;
  readonly defaultLLMModel: string = "gpt-4o";

  private constructor() {
    // Load and validate required environment variables
    this.port = Number(process.env.PORT) || 3000;

    this.openaiApiKey = process.env.OPENAI_API_KEY || "";
    if (!this.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is not set in .env file");
    }

    // Load MCP config from the config folder
    this.configPath = path.join(process.cwd(), "config", "mcp-config.json");
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Config file not found: ${this.configPath}`);
    }

    try {
      const config: Config = JSON.parse(
        fs.readFileSync(this.configPath, "utf-8")
      );
      this.mcpServers = config.mcpServers;

      if (
        !this.mcpServers ||
        !Array.isArray(this.mcpServers) ||
        this.mcpServers.length === 0
      ) {
        throw new Error("No MCP servers configured in config file");
      }
    } catch (error) {
      throw new Error(
        `Failed to parse config file: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get the singleton instance of Environment
   */
  public static getInstance(): Environment {
    if (!Environment.instance) {
      Environment.instance = new Environment();
    }
    return Environment.instance;
  }
}
