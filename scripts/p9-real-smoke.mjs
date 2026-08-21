import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./p9-real-smoke-runner.ts", import.meta.url));
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", runner, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);
child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (signal) {
    console.error(`P9 smoke terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
