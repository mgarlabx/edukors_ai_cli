/**
 * What an editor's settings screen needs, safe to bundle for a browser or
 * webview: no Node modules are imported from here.
 */
export { parseMcpConfig } from "./mcp/config.js";
export type { McpProblem, McpProblemCode } from "./mcp/config.js";
export { TOOL_SERVER_NAME } from "./constants.js";
export type { McpServerSpec } from "./mcp/external.js";
