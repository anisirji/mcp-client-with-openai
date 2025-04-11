import bodyParser from "body-parser";
export function startSseRoutes(app, mcpClient) {
    app.use(bodyParser.json()); // Ensure JSON body parsing
    app.set("mcpClient", mcpClient); // Attach MCPClient to the app
    // SSE stream endpoint
    app.get("/stream-sse", async (req, res, next) => {
        const query = req.query.q;
        if (!query) {
            res.status(400).send("Missing query");
            return;
        }
        const sessionId = req.query.session_id ||
            req.headers.cookie?.match(/session_id=([^;]+)/)?.[1] ||
            `session_${Date.now()}`;
        try {
            await mcpClient.handleQuerySSE(query, sessionId, res);
        }
        catch (err) {
            console.error("Error processing SSE query:", err);
            res.write(`data: ${JSON.stringify({ role: "error", content: String(err) })}\n\n`);
            res.end();
        }
    });
    app.post("/tool-permission", (req, res, next) => {
        const { sessionId, granted } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: "Session ID is required" });
        }
        mcpClient.handleToolPermission(sessionId, Boolean(granted));
        return res.status(200).json({ success: true });
    });
    // Inject agent message into session
    app.post("/inject-agent-message", async (req, res, next) => {
        const { session_id, message } = req.body;
        if (!session_id || !message) {
            res
                .status(400)
                .json({ success: false, message: "Missing session_id or message" });
            return;
        }
        const injected = mcpClient.injectAssistantMessage(session_id, message);
        if (injected) {
            const pushed = mcpClient.pushMessageToClient(session_id, "assistant", message);
            res.json({
                success: true,
                injected,
                pushed,
                message: pushed
                    ? "Message injected and pushed to frontend in real-time."
                    : "Message injected, but no active SSE connection found.",
            });
        }
        else {
            res.status(404).json({ success: false, message: "Session not found" });
        }
    });
    // Clear session
    app.get("/clear-session", (req, res, next) => {
        const sessionId = req.query.session_id ||
            req.headers.cookie?.match(/session_id=([^;]+)/)?.[1];
        if (sessionId) {
            const success = mcpClient.clearSession(sessionId);
            res.json({
                success,
                message: success ? "Session cleared" : "Session not found",
            });
        }
        else {
            res.status(400).json({ success: false, message: "Invalid session ID" });
        }
    });
}
