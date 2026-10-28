export { AiCli, createAiCli } from "./engine.js";
export type { AccountInfo, AiCliOptions, DiagnosticReport, OpenSessionOptions } from "./engine.js";
export { AiSession } from "./session.js";
export type { SendOptions, SessionState, TurnResult } from "./session.js";
export { AiCliError, ERROR_CODES, isAiCliError, toAiCliError } from "./errors.js";
export type { ErrorCode, ErrorMeta, SerializedError } from "./errors.js";
export type { ActivityPhase, AiEvent, AiEventBody, AiEventListener, AiEventType, EventScope, SessionCloseReason, Usage } from "./events.js";
export type {
  AccountContext,
  AccountState,
  AccountStatus,
  Capabilities,
  Detection,
  DetectionStatus,
  ModelInfo,
  ProviderAdapter,
  ProviderSession,
  SessionContext,
  SessionHooks,
  SessionOptions,
  TurnInput,
  TurnOutcome,
  TurnSink,
} from "./provider.js";
export { defineTool } from "./tools.js";
export type { ToolCallContext, ToolDefinition, ToolResult, ToolSpec, ValidationResult } from "./tools.js";
export { Diagnostics } from "./diagnostics.js";
export type { DiagnosticEntry, LogLevel, LogSink, ScopedLog } from "./diagnostics.js";
export { redactText, redactValue } from "./redact.js";
export { buildEnv, commonBinDirs } from "./platform/env.js";
export { compareVersions, findExecutable, readVersion } from "./platform/discovery.js";
export { ManagedProcess, killAllSync, readLines, runCommand } from "./platform/process.js";
export { DataPaths, defaultDataDir, documentKey } from "./platform/paths.js";
export { AccountRegistry, REGISTRY_SCHEMA_VERSION } from "./registry/registry.js";
export type { AccountRecord } from "./registry/registry.js";
export { VERSION } from "./version.js";
