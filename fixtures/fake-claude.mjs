#!/usr/bin/env node
// A stand-in for the `claude` executable, for what the adapter runs directly:
// `--version` and `auth status|login|logout`, with the sign-in kept in
// CLAUDE_CONFIG_DIR as the real one keys it. Conversations go through the
// Agent SDK, which the tests replace (test/fakeClaudeSdk.ts).
//
// Toggles: FAKE_CLAUDE_VERSION, FAKE_CLAUDE_LOGIN=fail.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.312"} (Claude Code)`);
  process.exit(0);
}
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) {
  console.error("CLAUDE_CONFIG_DIR is not set");
  process.exit(2);
}
const authFile = join(dir, "fake-auth.json");

if (args[0] === "auth" && args[1] === "status") {
  const signed = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : null;
  console.log(JSON.stringify(signed ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: signed.email, configDirectory: dir } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty", configDirectory: dir }, null, 2));
  process.exit(signed ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login") {
  if (process.env.FAKE_CLAUDE_LOGIN === "fail") {
    console.error("OAuth error: access denied");
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(authFile, JSON.stringify({ email: `${basename(dir)}@example.org`, token: "fake-claude-oauth-token" }));
  console.log("Login successful.");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "logout") {
  rmSync(authFile, { force: true });
  console.log("Successfully logged out.");
  process.exit(0);
}
console.error(`unsupported: ${args.join(" ")}`);
process.exit(2);
