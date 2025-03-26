#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers";
import { StdioClientTransport } from "../StdioClientTransport.js";
import * as util from "node:util";
import { startSSEServer } from "../startSSEServer.js";
import { proxyServer } from "../proxyServer.js";
import 'dotenv/config'
util.inspect.defaultOptions.depth = 8;

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

const argv = await yargs(hideBin(process.argv))
  .scriptName("mcp-proxy")
  .command("$0 <command> [args...]", "Run a command with MCP arguments")
  .positional("command", {
    type: "string",
    describe: "The command to run",
    demandOption: true,
  })
  .positional("args", {
    type: "string",
    array: true,
    describe: "The arguments to pass to the command",
  })
  .env("MCP_PROXY")
  .options({
    debug: {
      type: "boolean",
      describe: "Enable debug logging",
      default: false,
    },
    endpoint: {
      type: "string",
      describe: "The endpoint to listen on for SSE",
      default: "/sse",
    },
    port: {
      type: "number",
      describe: "The port to listen on for SSE",
      default: 8080,
    },
    apiKeyHeaderName: {
      type: "string",
      describe: "Header name for the API key (default: x-api-key)",
      default: "x-api-key",
    },
  })
  .help()
  .parseAsync();

const connect = async (client: Client) => {
  const transport = new StdioClientTransport({
    command: argv.command,
    args: argv.args,
    env: process.env as Record<string, string>,
    stderr: "pipe",
    onEvent: (event) => {
      if (argv.debug) {
        console.debug("transport event", event);
      }
    },
  });

  await client.connect(transport);
};

// Function to verify API key from remote authentication server
const verifyApiKey = async (apiKey: string, authServerUrl: string) => {
  if (!authServerUrl) return null;
  
  try {
    const response = await fetch(`${authServerUrl}?apiKey=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`Auth server returned status: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (data.valid) {
      return {
        userId: data.userId || `user-${apiKey.substring(0, 8)}`,
        permissions: data.permissions || [],
        env: data.env || {}
      };
    }
    
    return null;
  } catch (error) {
    console.error("API key verification error:", error);
    return null;
  }
};

const proxy = async () => {
  const client = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await connect(client);

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = client.getServerCapabilities() as {};

  console.info("starting the SSE server on port %d", argv.port);
  
  // Get authentication server URL from environment variable
  const authServerUrl = process.env.AUTH_SERVER_URL;
  
  // Setup remote API key verification
  let remoteVerification = false;
  if (authServerUrl) {
    remoteVerification = true;
    console.info(`Remote API key verification enabled (URL: ${authServerUrl})`);
  } else {
    console.warn("AUTH_SERVER_URL environment variable not set. API key verification will be done locally.");
  }

  await startSSEServer({
    createServer: async (_req, userId, env) => {
      console.info(`Creating server for user: ${userId || 'anonymous'}`);
      
      if (env) {
        console.info(`Using custom environment variables for this session`);
        
        // Apply the environment variables from the API to the current process.env
        // This will affect the environment for this specific request
        Object.entries(env).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            process.env[key] = value.toString();
          }
        });
      }
      
      // Create the server with the updated environment
      const server = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      proxyServer({
        server,
        client,
        serverCapabilities,
      });

      return server;
    },
    port: argv.port,
    endpoint: argv.endpoint as `/${string}`,
    apiKeyHeaderName: argv.apiKeyHeaderName,
    // Custom authentication handler for remote verification
    authHandler: async (requestApiKey: string) => {
      if (!requestApiKey) return null;
      
      // Verify API key with remote server
      if (remoteVerification) {
        return await verifyApiKey(requestApiKey, authServerUrl as string);
      }
      
      // If no remote verification, just accept any API key
      return { userId: `user-${requestApiKey.substring(0, 8)}` };
    }
  });

  console.info(`API key authentication enabled (header: ${argv.apiKeyHeaderName})`);
  if (remoteVerification) {
    console.info(`Using remote verification server at ${authServerUrl}`);
  } else {
    console.info(`No remote verification server configured. All API keys will be accepted.`);
  }
};

const main = async () => {
  process.on("SIGINT", () => {
    console.info("SIGINT received, shutting down");

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  try {
    await proxy();
  } catch (error) {
    console.error("could not start the proxy", error);

    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

await main();
