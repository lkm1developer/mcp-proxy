import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type SSEServer = {
  close: () => Promise<void>;
};

type ServerLike = {
  connect: Server["connect"];
  close: Server["close"];
};

export type AuthResult = {
  userId: string;
  permissions?: string[];
  env?: Record<string, string>;
} | null;

export type AuthHandler = (apiKey: string) => Promise<AuthResult>;

export const startSSEServer = async <T extends ServerLike>({
  port,
  createServer,
  endpoint,
  onConnect,
  onClose,
  onUnhandledRequest,
  apiKey,
  apiKeyHeaderName = "x-api-key",
  authHandler,
}: {
  port: number;
  endpoint: string;
  createServer: (request: http.IncomingMessage, userId?: string, env?: Record<string, string>) => Promise<T>;
  onConnect?: (server: T, userId?: string) => void;
  onClose?: (server: T) => void;
  onUnhandledRequest?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
  apiKey?: string; // API key for authentication
  apiKeyHeaderName?: string;
  authHandler?: AuthHandler; // Custom authentication handler
}): Promise<SSEServer> => {
  const activeTransports: Record<string, { 
    transport: SSEServerTransport; 
    userId?: string;
    env?: Record<string, string>;
    apiKey?: string; // Store the API key with the session
  }> = {};

  /**
   * @author https://dev.classmethod.jp/articles/mcp-sse/
   */
  console.info("http.createServer on port %d", port);
  const httpServer = http.createServer(async (req, res) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);

        res.setHeader("Access-Control-Allow-Origin", origin.origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
      } catch (error) {
        console.error("Error parsing origin:", error);
      }
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === `/ping`) {
      res.writeHead(200).end("pong");
      return;
    }

    if (req.method === "GET" && req.url?.startsWith(endpoint)) {
      console.info(`Incoming request: ${req.method} ${req.url}, headers: ${JSON.stringify(req.headers)} endpoint: ${endpoint}`);
      
      // Check API key if authentication is enabled
      let userId: string | undefined;
      let env: Record<string, string> | undefined;
      
      // Check for API key in headers
      let requestApiKey = req.headers[apiKeyHeaderName.toLowerCase()] as string;
      
      // If not in headers, check URL query parameters
      if (!requestApiKey && req.url !== endpoint) {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          requestApiKey = url.searchParams.get('apiKey') || '';
          
          // If we found an API key in the URL, log it
          if (requestApiKey) {
            console.info(`Using API key from URL query parameter`);
          }
        } catch (error) {
          console.error("Error parsing URL for API key:", error);
        }
      }
      
      // Always require an API key
      if (!requestApiKey) {
        res.writeHead(401).end("Unauthorized: Missing API key");
        return;
      }
      
      // If API key is provided, validate it
      if (requestApiKey) {
        // Use custom auth handler if provided
        if (authHandler) {
          const authResult = await authHandler(requestApiKey);
          if (!authResult) {
            res.writeHead(401).end("Unauthorized: Invalid API key");
            return;
          }
          userId = authResult.userId;
          env = authResult.env;
        }
        // Fall back to single API key check
        else if (apiKey && requestApiKey !== apiKey) {
          res.writeHead(401).end("Unauthorized: Invalid API key");
          return;
        }
      }

      const transport = new SSEServerTransport("/messages", res);

      let server: T;

      try {
        server = await createServer(req, userId, env);
      } catch (error) {
        if (error instanceof Response) {
          res.writeHead(error.status).end(error.statusText);
          return;
        }

        res.writeHead(500).end("Error creating server");
        return;
      }

      activeTransports[transport.sessionId] = { transport, userId, env, apiKey: requestApiKey };

      let closed = false;

      res.on("close", async () => {
        closed = true;

        try {
          await server.close();
        } catch (error) {
          console.error("Error closing server:", error);
        }

        delete activeTransports[transport.sessionId];

        onClose?.(server);
      });

      try {
        await server.connect(transport);

        await transport.send({
          jsonrpc: "2.0",
          method: "sse/connection",
          params: { message: "SSE Connection established" },
        });

        onConnect?.(server, userId);
      } catch (error) {
        if (!closed) {
          console.error("Error connecting to server:", error);
          res.writeHead(500).end("Error connecting to server");
        }
      }

      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      console.info(`Incoming request: ${req.method} ${req.url}, headers: ${JSON.stringify(req.headers)} endpoint: ${endpoint}`);
      
      // Get the session ID from the URL
      const sessionId = new URL(
        req.url,
        "https://example.com",
      ).searchParams.get("sessionId");

      if (!sessionId) {
        res.writeHead(400).end("No sessionId");
        return;
      }

      // Get the active session
      const activeSession = activeTransports[sessionId];

      if (!activeSession) {
        res.writeHead(400).end("No active transport");
        return;
      }
      
      // Use the API key from the session if available
      // If we have an API key stored with the session, we don't need to validate it again
      // The session was already validated during the initial connection
      
      // Handle the POST message
      await activeSession.transport.handlePostMessage(req, res);
      
      return;
    }

    if (onUnhandledRequest) {
      await onUnhandledRequest(req, res);
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve) => {
    httpServer.listen(port, "::", () => {
      resolve(undefined);
    });
  });
  
  console.info(`SSE server started on port ${port}`);
  
  return {
    close: async () => {
      for (const session of Object.values(activeTransports)) {
        await session.transport.close();
      }

      return new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};
