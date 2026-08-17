import { pathToFileURL } from "node:url";
export { createRequestHandler } from "./http/server.ts";
export { createInspectorRequestHandler } from "./http/inspector.ts";
export { createInspectorStaticHandler } from "./http/inspector-static.ts";
export { createMemorySpaceDaemon, startServer } from "./daemon.ts";
import { startServer } from "./daemon.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
