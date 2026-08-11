import { fileURLToPath } from "node:url";
import {
  codexUnavailableOutput,
  type CodexHookOutput
} from "./bootstrap-renderer.ts";
import { invokeCodexLifecycleHook } from "./hook-client.ts";

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Codex hook input exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Codex hook input is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeOutput(output: CodexHookOutput | undefined): void {
  if (output) process.stdout.write(JSON.stringify(output));
}

export async function runCodexHook(): Promise<void> {
  try {
    writeOutput(await invokeCodexLifecycleHook(await readStdin()));
  } catch {
    writeOutput(codexUnavailableOutput());
  }
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) void runCodexHook();
