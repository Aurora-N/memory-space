import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createDefaultMemorySpace } from "../composition.ts";
import { createMemoryMcpServer } from "./server.ts";

const databasePath = process.env.MEMORY_SPACE_DB ?? "./data/memory-space.db";
const coreLimit = Number(process.env.MEMORY_SPACE_CORE_LIMIT ?? 64);
const memorySpace = createDefaultMemorySpace({ databasePath, coreLimit });
const server = createMemoryMcpServer({
  memorySpace,
  cwd: process.env.MEMORY_SPACE_CWD ?? process.cwd()
});

await server.connect(new StdioServerTransport());

const close = async (): Promise<void> => {
  await server.close();
  await memorySpace.close();
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
