import { spawn } from "node:child_process";
import { CliError } from "./errors.ts";

export async function openLocalBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  }).catch((error: unknown) => {
    throw new CliError("INSPECTOR_UNAVAILABLE", "The browser could not be opened.", {
      remediation: `Open ${url} manually, or retry with --no-open.`,
      cause: error
    });
  });
}
