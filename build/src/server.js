import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import bodyParser from "body-parser";
import { MCPService } from "./services/MCPService.js";
import { setupApiRoutes } from "./routes/apiRoutes.js";
import { Environment } from "./config/environment.js";
import { errorHandler } from "./middleware/errorHandler.js";
/**
 * Configures and starts the Express server
 */
export async function startServer() {
    // Get environment configuration
    const config = Environment.getInstance();
    // Create Express application
    const app = express();
    // Middleware for request parsing
    app.use(express.json());
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    // Resolve __dirname in ES modules
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Serve static files from the public directory
    app.use(express.static(path.join(__dirname, "../public")));
    // Set up API routes
    setupApiRoutes(app);
    // Default route to serve index.html
    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "../public", "index.html"));
    });
    // Error handling middleware
    app.use(errorHandler);
    // Start server and connect to MCP servers
    try {
        // Connect to MCP servers first
        const mcpService = MCPService.getInstance();
        await mcpService.connectToServers();
        // Start the Express server
        app.listen(config.port, () => {
            console.log(`✅ Server running at http://localhost:${config.port}`);
        });
    }
    catch (error) {
        console.error("❌ Failed to start server:", error);
        process.exit(1);
    }
}
