# MCP Proxy Auth

A TypeScript SSE proxy for MCP servers that use stdio transport, with authentication support.

> **Note:** Beta version used for testing. Do not use in production.

## Overview

`mcp-proxy-auth` extends the [mcp-proxy](https://www.npmjs.com/package/mcp-proxy) package with authentication capabilities. It allows you to:

1. Convert stdio-based MCP servers to SSE (Server-Sent Events) protocol
2. Add API key authentication to your MCP servers
3. Support both local and remote authentication validation
4. Pass user-specific environment variables to MCP servers

## Installation

```bash
npm install mcp-proxy-auth
```

## Basic Usage

The package provides a command-line tool to proxy stdio-based MCP servers to SSE:

```bash
npx mcp-proxy-auth your-mcp-server [args...]
```

By default, this starts an SSE server on port 8080 with the endpoint `/sse`.

## Authentication Implementation

### Basic API Key Authentication

By default, the proxy requires an API key for all requests. You can specify the header name for the API key:

```bash
npx mcp-proxy your-mcp-server --apiKeyHeaderName "x-api-key"
```

Clients must include this header in their requests:

```javascript
// Client-side example
const eventSource = new EventSource('http://localhost:8080/sse', {
  headers: {
    'x-api-key': 'your-api-key'
  }
});
```

API keys can also be passed as URL parameters:

```
http://localhost:8080/sse?apiKey=your-api-key
```

### Remote Authentication Server

For more advanced authentication, you can configure a remote authentication server:

1. Set the `AUTH_SERVER_URL` environment variable to point to your authentication server:

```bash
export AUTH_SERVER_URL="https://your-auth-server.com/verify"
```

2. The authentication server should accept GET requests with an `apiKey` parameter and return a JSON response:

```json
{
  "valid": true,
  "userId": "user123",
  "permissions": ["read", "write"],
  "env": {
    "CUSTOM_VAR": "value",
    "API_TOKEN": "user-specific-token"
  }
}
```

3. If authentication is successful, the `userId` and custom environment variables will be passed to the MCP server.

### Implementing Authentication in Your SSE Server

To implement authentication in your own SSE server using this package:

```typescript
import { startSSEServer } from 'mcp-proxy-auth';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Custom authentication handler
const authHandler = async (apiKey: string) => {
  // Verify the API key (e.g., against a database)
  if (apiKey === 'valid-key') {
    return {
      userId: 'user123',
      permissions: ['read', 'write'],
      env: {
        // Custom environment variables for this user
        USER_API_TOKEN: 'user-specific-token'
      }
    };
  }
  return null; // Authentication failed
};

// Start the SSE server with authentication
await startSSEServer({
  port: 8080,
  endpoint: '/sse',
  apiKeyHeaderName: 'x-api-key',
  authHandler,
  createServer: async (req, userId, env) => {
    console.log(`Creating server for user: ${userId || 'anonymous'}`);
    
    // Create your MCP server
    const server = new Server(
      { name: 'your-server', version: '1.0.0' },
      { capabilities: { /* your capabilities */ } }
    );
    
    // Set up your request handlers
    // ...
    
    return server;
  }
});
```

## Converting stdio to SSE Protocol

The package handles the conversion between stdio and SSE protocols automatically:

1. **Stdio to SSE**: The `StdioClientTransport` class connects to a stdio-based MCP server and forwards messages to the SSE server.

2. **SSE to stdio**: The SSE server receives client requests via HTTP and forwards them to the stdio-based MCP server.

Here's how the conversion works:

```
Client (Browser) <--SSE--> MCP Proxy Auth <--stdio--> MCP Server
```

The proxy:
1. Starts your MCP server as a child process
2. Communicates with it via stdin/stdout
3. Exposes an SSE endpoint for clients to connect
4. Handles authentication before allowing connections
5. Forwards messages between clients and the MCP server

## Environment Variables

- `AUTH_SERVER_URL`: URL of the remote authentication server
- `MCP_PROXY_PORT`: Port for the SSE server (default: 8080)
- `MCP_PROXY_ENDPOINT`: Endpoint for the SSE server (default: "/sse")
- `MCP_PROXY_API_KEY_HEADER_NAME`: Header name for the API key (default: "x-api-key")
- `MCP_PROXY_DEBUG`: Enable debug logging (set to "true")

## API Reference

### startSSEServer

```typescript
function startSSEServer({
  port,
  endpoint,
  createServer,
  onConnect,
  onClose,
  onUnhandledRequest,
  apiKey,
  apiKeyHeaderName,
  authHandler,
}: {
  port: number;
  endpoint: string;
  createServer: (request: http.IncomingMessage, userId?: string, env?: Record<string, string>) => Promise<T>;
  onConnect?: (server: T, userId?: string) => void;
  onClose?: (server: T) => void;
  onUnhandledRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  apiKey?: string;
  apiKeyHeaderName?: string;
  authHandler?: (apiKey: string) => Promise<AuthResult>;
}): Promise<SSEServer>
```

### AuthResult

```typescript
type AuthResult = {
  userId: string;
  permissions?: string[];
  env?: Record<string, string>;
} | null;
```

## Example: Complete SSE Server with Authentication

```typescript
import { startSSEServer } from 'mcp-proxy-auth';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as http from 'http';

// Database of valid API keys (in a real app, use a proper database)
const apiKeys = {
  'test-key-1': { userId: 'user1', env: { USER_TOKEN: 'token1' } },
  'test-key-2': { userId: 'user2', env: { USER_TOKEN: 'token2' } }
};

// Start the SSE server
await startSSEServer({
  port: 8080,
  endpoint: '/sse',
  apiKeyHeaderName: 'x-api-key',
  
  // Custom authentication handler
  authHandler: async (apiKey) => {
    const user = apiKeys[apiKey];
    if (user) {
      return {
        userId: user.userId,
        permissions: ['read', 'write'],
        env: user.env
      };
    }
    return null; // Authentication failed
  },
  
  // Create a new server for each connection
  createServer: async (req, userId, env) => {
    console.log(`New connection from ${userId || 'anonymous'}`);
    
    // Create the MCP server
    const server = new Server(
      { name: 'example-server', version: '1.0.0' },
      { capabilities: { resources: { subscribe: true } } }
    );
    
    // Set up request handlers
    server.setRequestHandler(/* ... */);
    
    return server;
  },
  
  // Optional handlers
  onConnect: (server, userId) => {
    console.log(`Server connected for user ${userId}`);
  },
  
  onClose: (server) => {
    console.log('Server connection closed');
  },
  
  onUnhandledRequest: async (req, res) => {
    res.writeHead(404).end('Not found');
  }
});

console.log('SSE server running on http://localhost:8080/sse');
```

## Related

- [mcp-proxy](https://www.npmjs.com/package/mcp-proxy) - The base package without authentication
- [Model Context Protocol](https://modelcontextprotocol.github.io/) - Official MCP documentation
