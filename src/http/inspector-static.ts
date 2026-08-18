import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'"
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Missing or unreadable optional assets are handled by the normal 404 path.
    return false;
  }
}

export function createInspectorStaticHandler(directory: string | false) {
  const root = directory === false ? undefined : resolve(directory);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://memory-space.local");
    if (url.pathname === "/inspector") {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      response.writeHead(307, { location: "/inspector/", ...securityHeaders() });
      response.end();
      return true;
    }
    if (!url.pathname.startsWith("/inspector/") || url.pathname.startsWith("/inspector/api/")) {
      return false;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    if (!root) return false;

    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname.slice("/inspector/".length));
    } catch {
      response.writeHead(400, securityHeaders());
      response.end("Invalid Inspector path");
      return true;
    }
    const requestedPath = resolve(root, relativePath || "index.html");
    if (requestedPath !== root && !requestedPath.startsWith(`${root}${sep}`)) {
      response.writeHead(404, securityHeaders());
      response.end("Not found");
      return true;
    }
    const requestedFileExists = await isFile(requestedPath);
    if (!requestedFileExists && relativePath !== "" && extname(relativePath) !== "") {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders()
      });
      response.end("Not found");
      return true;
    }
    const filePath = requestedFileExists ? requestedPath : resolve(root, "index.html");
    if (!await isFile(filePath)) {
      response.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders()
      });
      response.end("Memory Space Inspector is not built. Run: pnpm inspector:build");
      return true;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      ...securityHeaders()
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}
