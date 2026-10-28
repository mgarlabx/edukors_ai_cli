import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ScopedLog } from "../diagnostics.js";
import type { ToolResult, ToolSpec } from "../tools.js";
import { VERSION } from "../version.js";

/**
 * The application's tools as an MCP server. Providers that host MCP servers
 * in-process (Claude through the Agent SDK) get the instance; providers that
 * only take a URL (Codex) get it over HTTP on 127.0.0.1, behind a token made
 * for one session. Either way every call goes through `call`, which is the
 * session's turn sink: validation, events and cancellation stay in the core.
 */

export const TOOL_SERVER_NAME = "edukors";

export type ToolCaller = (name: string, args: unknown) => Promise<ToolResult>;

/** The largest request body the bridge reads; tool arguments are small. */
const MAX_BODY = 4 << 20;

export function createToolMcpServer(tools: readonly ToolSpec[], call: ToolCaller, name: string = TOOL_SERVER_NAME): McpServer {
  const mcp = new McpServer({ name, version: VERSION }, { capabilities: { tools: {} } });
  // The low-level handlers take the JSON Schema as the application wrote it.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object" as const, ...t.inputSchema } })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await call(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text" as const, text: result.content }], isError: Boolean(result.isError) };
  });
  return mcp;
}

/** One MCP server the bridge serves: the application's (`edukors`) or one of the user's, under its own name. */
export interface BridgedServer {
  name: string;
  tools: readonly ToolSpec[];
  call: ToolCaller;
}

export interface ToolBridge {
  /** The address of the application's tools (`/mcp`). */
  url: string;
  /** The address of a server by name: `/mcp` for the application's, `/mcp/<name>` for the others. */
  urlFor(name: string): string;
  /** Sent by the provider as `Authorization: Bearer <token>`. Never written to disk or argv. */
  token: string;
  close(): Promise<void>;
}

export async function startToolBridge(servers: readonly BridgedServer[], log: ScopedLog): Promise<ToolBridge> {
  const token = randomBytes(24).toString("base64url");
  const expected = `Bearer ${token}`;
  const byPath = new Map(servers.map((s) => [s.name === TOOL_SERVER_NAME ? "/mcp" : `/mcp/${s.name}`, s]));

  // Stateless: one server and transport per request, which is all a CLI needs.
  async function serve(target: BridgedServer, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = createToolMcpServer(target.tools, target.call, target.name);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http = createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => log.debug(`tool bridge ${req.method} ${(req.url ?? "").split("?")[0]} -> ${res.statusCode} (${Date.now() - started} ms)`));
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    const target = byPath.get((req.url ?? "").split("?")[0] ?? "");
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      let body: unknown;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"not JSON"}');
        return;
      }
      serve(target, req, res, body).catch((e) => {
        log.warn("tool bridge request failed", e);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  const urlFor = (name: string) => `http://127.0.0.1:${port}/mcp${name === TOOL_SERVER_NAME ? "" : `/${encodeURIComponent(name)}`}`;
  return {
    url: urlFor(TOOL_SERVER_NAME),
    urlFor,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
