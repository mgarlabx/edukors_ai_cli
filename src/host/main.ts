#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createAiCli } from "../engine.js";
import { bundledProviders } from "../providers.js";
import { runStdioHost } from "./stdio.js";

const { values } = parseArgs({
  options: {
    "app-id": { type: "string" },
    "data-dir": { type: "string" },
    fake: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

if (!values["app-id"]) {
  process.stderr.write("usage: edukors-ai-host --app-id <id> [--data-dir <dir>] [--fake] [--verbose]\n");
  process.exit(2);
}

const ai = createAiCli({
  appId: values["app-id"],
  providers: bundledProviders({ fake: values.fake }),
  ...(values["data-dir"] ? { dataDir: values["data-dir"] } : {}),
  logSink: (entry) => {
    if (values.verbose || entry.level === "warn" || entry.level === "error") process.stderr.write(`[${entry.level}] ${entry.scope}: ${entry.message}\n`);
  },
});

const { closed } = runStdioHost({ ai, input: process.stdin, output: process.stdout });
await closed;
process.exit(0);
