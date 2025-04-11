import express, { Request, Response, NextFunction } from "express";
import { ConversationController } from "../controllers/ConversationController.js";
import { extractSessionId } from "../utils/helpers.js";
import { sendSSEError } from "../utils/sse.js";

/**
 * Creates and configures API routes for the application
 * @param app Express application instance
 */
export function setupApiRoutes(app: express.Application): void {
  const router = express.Router();
  const conversationController = ConversationController.getInstance();

  // SSE stream endpoint for real-time chat - keep at root level for backward compatibility
  app.get(
    "/stream-sse",
    async (req: Request, res: Response, next: NextFunction) => {
      const query = req.query.q as string;

      if (!query) {
        res.status(400).send("Missing query parameter");
        return;
      }

      // Extract or generate session ID
      const sessionId = extractSessionId(
        req.query.session_id as string,
        req.headers.cookie
      );

      try {
        await conversationController.handleQuerySSE(query, sessionId, res);
      } catch (err) {
        console.error("Error processing SSE query:", err);
        sendSSEError(res, err);
      }
    }
  );

  // Tool permission endpoint - keep at root level for backward compatibility
  app.post(
    "/tool-permission",
    (req: Request, res: Response, next: NextFunction) => {
      const { sessionId, granted } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: "Session ID is required" });
        return;
      }

      try {
        conversationController.handleToolPermission(
          sessionId,
          Boolean(granted)
        );
        res.status(200).json({ success: true });
      } catch (error) {
        console.error("Error handling tool permission:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // Clear session endpoint - keep at root level for backward compatibility
  app.get(
    "/clear-session",
    (req: Request, res: Response, next: NextFunction) => {
      const sessionId = extractSessionId(
        req.query.session_id as string,
        req.headers.cookie
      );

      try {
        const success = conversationController.clearSession(sessionId);

        res.json({
          success,
          message: success ? "Session cleared" : "Session not found",
        });
      } catch (error) {
        console.error("Error clearing session:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // Add these routes to the /api prefix as well for forward compatibility

  // Inject message endpoint
  router.post(
    "/inject-message",
    async (req: Request, res: Response, next: NextFunction) => {
      const { session_id, message } = req.body;

      if (!session_id || !message) {
        res.status(400).json({
          success: false,
          message: "Missing session_id or message",
        });
        return;
      }

      try {
        const injected = conversationController.injectAssistantMessage(
          session_id,
          message
        );

        if (injected) {
          const pushed = conversationController.pushMessageToClient(
            session_id,
            "assistant",
            message
          );

          res.json({
            success: true,
            injected,
            pushed,
            message: pushed
              ? "Message injected and pushed to frontend in real-time."
              : "Message injected, but no active SSE connection found.",
          });
        } else {
          res
            .status(404)
            .json({ success: false, message: "Session not found" });
        }
      } catch (error) {
        console.error("Error injecting message:", error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  // Register the router with the /api prefix for future endpoints
  app.use("/api", router);
}
