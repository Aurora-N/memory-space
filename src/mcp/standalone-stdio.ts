import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createDefaultMemorySpace } from "../composition.ts";
import { createMemoryMcpServer } from "./server.ts";

if (process.env.MEMORY_SPACE_ALLOW_STANDALONE !== "1") {
  console.error(
    "Standalone stdio owns its SQLite connection and is development-only. "
    + "Use the daemon /mcp endpoint, or set MEMORY_SPACE_ALLOW_STANDALONE=1 explicitly."
  );
  process.exit(1);
}

console.error(
  "WARNING: standalone development MCP mode owns SQLite; do not run it with the daemon or another instance."
);
const databasePath = process.env.MEMORY_SPACE_DB ?? "./data/memory-space.db";
const coreLimit = Number(process.env.MEMORY_SPACE_CORE_LIMIT ?? 64);
const memorySpace = createDefaultMemorySpace({ databasePath, coreLimit });
const server = createMemoryMcpServer({
  memorySpace,
  cwd: process.env.MEMORY_SPACE_CWD ?? process.cwd(),
  explicitSpaceId: process.env.MEMORY_SPACE_SPACE_ID
});

await server.connect(new StdioServerTransport());

const close = async (): Promise<void> => {
  await server.close();
  await memorySpace.close();
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
