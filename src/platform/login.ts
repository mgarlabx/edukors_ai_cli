import { AiCliError } from "../errors.js";
import type { AccountContext } from "../provider.js";
import { ManagedProcess, readLines, type CommandSpec, type RunResult } from "./process.js";

/**
 * Runs a provider's sign-in command. Such commands open the browser and wait
 * for it; when the browser cannot be opened they print an address instead,
 * and some then wait for a code pasted on their input. The address goes to
 * the application (`context.login.prompt`), and a code the user pastes goes
 * to the command's input, so the whole flow works without a terminal.
 */
export interface LoginCommandOptions {
  /** The sign-in address among everything the command prints. */
  urlPattern: RegExp;
  acceptsCode: boolean;
  timeoutMs?: number;
}

const MAX_OUTPUT = 64 << 10;

export async function runLoginCommand(spec: CommandSpec, context: AccountContext, options: LoginCommandOptions): Promise<RunResult> {
  const proc = new ManagedProcess(spec);
  const spawnError = new Promise<Error>((resolve) => proc.child.once("error", resolve));
  let stdout = "";
  let offered = false;
  const onLine = (line: string) => {
    if (stdout.length < MAX_OUTPUT) stdout += line + "\n";
    if (offered) return;
    const url = line.match(options.urlPattern)?.[0];
    if (!url) return;
    offered = true;
    // Wait for the code before offering the address: an application may answer at once.
    if (options.acceptsCode && context.login) {
      context.login.code().then(
        (code) => proc.child.stdin.write(`${code}\n`),
        () => undefined,
      );
    }
    context.login?.prompt({ url, acceptsCode: options.acceptsCode });
  };
  readLines(proc.child.stdout, onLine);
  readLines(proc.child.stderr, onLine);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void proc.terminate(500);
  }, options.timeoutMs ?? 10 * 60_000);
  const onAbort = () => void proc.terminate(500);
  context.signal?.addEventListener("abort", onAbort, { once: true });
  const info = await proc.exited;
  clearTimeout(timer);
  context.signal?.removeEventListener("abort", onAbort);

  if (info.code === null && info.signal === null) throw new AiCliError("PROVIDER_START_FAILED", `could not start ${spec.file}`, { cause: await spawnError });
  if (context.signal?.aborted) throw new AiCliError("CANCELLED", "sign-in cancelled");
  return { code: info.code, stdout, stderr: proc.stderr.toString(), timedOut };
}
