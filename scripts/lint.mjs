import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "test", "eval"];
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if ([".js", ".mjs", ".ts"].includes(extname(path))) files.push(path);
  }
}

for (const root of roots) {
  try {
    walk(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const failures = [];
for (const file of files.sort()) {
  const source = readFileSync(file, "utf8");
  source.split("\n").forEach((line, index) => {
    if (/\s+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
    if (line.includes("\t")) failures.push(`${file}:${index + 1}: tab character`);
  });
  if (extname(file) !== ".ts") {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) failures.push(result.stderr.trim());
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} source files.`);
}
