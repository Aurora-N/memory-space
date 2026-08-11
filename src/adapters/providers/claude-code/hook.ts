import { fileURLToPath } from "node:url";
import {
  claudeCodeUnavailableOutput,
  type ClaudeCodeHookOutput
} from "./bootstrap-renderer.ts";
import { invokeClaudeCodeLifecycleHook } from "./hook-client.ts";

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new Error("Claude Code hook input exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Claude Code hook input is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeOutput(output: ClaudeCodeHookOutput | undefined): void {
  if (output) process.stdout.write(JSON.stringify(output));
}

export async function runClaudeCodeHook(): Promise<void> {
  try {
    writeOutput(await invokeClaudeCodeLifecycleHook(await readStdin()));
  } catch {
    writeOutput(claudeCodeUnavailableOutput());
  }
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) void runClaudeCodeHook();
