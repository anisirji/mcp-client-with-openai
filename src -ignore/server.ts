import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { MCPClient } from "./services/mcpClient.js";
import { startSseRoutes } from "./routes/ssRoutes.js";
import { SSEClientTransport } from "./SSEclient.js";

import dotenv from "dotenv";

dotenv.config();

const PORT: number = Number(process.env.PORT) || 3000;

export function startServer(): void {
  const app = express();

  // Middleware for JSON
  app.use(express.json());

  // Resolve __dirname correctly
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Serve static files from the public directory
  app.use(express.static(path.join(__dirname, "../public")));

  // Create MCPClient instance and attach SSE routes
  const mcpClient = new MCPClient();
  startSseRoutes(app, mcpClient);

  // Default route to serve index.html
  app.get("/", (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../public", "index.html"));
  });

  // Start the server and connect to MCP servers
  app.listen(PORT, async () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    await mcpClient.connectToServers();
  });
}
