import { startServer } from "./src/server.js"; // Adjust the path accordingly
// Start the server and handle errors
startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
