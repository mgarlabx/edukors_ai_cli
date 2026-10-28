#!/usr/bin/env node
// A user's MCP server, for the tests: stdio, two tools. `lookup` answers,
// `broken` fails. FAKE_MCP_SECRET, when set in the server's own env, is
// echoed so a test can tell the configured environment reached it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "glossary", version: "1.0.0" });
server.registerTool("lookup", { description: "Looks a term up in the glossary.", inputSchema: { term: z.string() } }, async ({ term }) => ({
  content: [{ type: "text", text: `${term}: a term from the glossary${process.env.FAKE_MCP_SECRET ? ` (env ${process.env.FAKE_MCP_SECRET})` : ""}` }],
}));
server.registerTool("broken", { description: "Always fails.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "the glossary is offline" }], isError: true }));
await server.connect(new StdioServerTransport());
