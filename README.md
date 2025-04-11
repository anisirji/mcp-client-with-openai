# MCP Client TypeScript

A Node.js client for Model Context Protocol (MCP) servers with TypeScript.

## Project Architecture

This project follows Clean Code and SOLID principles with a modular architecture:

```
src/
├── config/         # Configuration management
│   └── environment.ts
├── controllers/    # Request handling logic
│   └── ConversationController.ts
├── middleware/     # Express middleware
│   └── errorHandler.ts
├── routes/         # API routes
│   └── apiRoutes.ts
├── services/       # Core business logic 
│   ├── MCPService.ts
│   ├── OpenAIService.ts
│   └── SessionManager.ts
├── types/          # TypeScript type definitions
│   └── index.ts
├── utils/          # Utility functions
│   ├── helpers.ts
│   └── sse.ts
└── server.ts       # Express server setup
```

## Core Components

- **Environment**: Centralized configuration management
- **MCPService**: Handles connections to MCP servers and tool execution
- **OpenAIService**: Manages OpenAI API interactions
- **SessionManager**: Manages user chat sessions and active streams
- **ConversationController**: Implements conversation handling logic
- **API Routes**: Defines HTTP endpoints for the application

## Design Principles Applied

- **Single Responsibility Principle**: Each class has a single reason to change
- **Open/Closed Principle**: Components are open for extension but closed for modification
- **Dependency Inversion**: High-level modules depend on abstractions
- **DRY (Don't Repeat Yourself)**: Code duplication is minimized
- **KISS (Keep It Simple, Stupid)**: Logic is simple and straightforward
- **Separation of Concerns**: Clear boundaries between components

## Getting Started

### Prerequisites

- Node.js (v16+)
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Set up environment variables in `.env`:
   ```
   PORT=3000
   OPENAI_API_KEY=your_openai_api_key
   ```
4. Configure MCP servers in `config/mcp-config.json`

### Running the Application

Development mode:
```
npm run dev
```

Production mode:
```
npm run build
npm start
```

## API Endpoints

- `GET /api/stream-sse` - Server-Sent Events endpoint for real-time chat
- `POST /api/tool-permission` - Approve/deny tool usage
- `POST /api/inject-message` - Inject an assistant message
- `GET /api/clear-session` - Clear a chat session 