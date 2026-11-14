import { createServer } from "node:http";
import { CanvasRenderer } from "./canvasRenderer.js";
import { CanvasRenderFailure } from "./canvasRenderPolicy.js";

export function canvasRenderServer(renderer: CanvasRenderer) {
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (request.url === "/healthz" && request.method === "GET") { response.end('{"ok":true}'); return; }
    if (request.url !== "/render" || request.method !== "POST") { response.writeHead(404); response.end('{"error":{"code":"NOT_FOUND"}}'); return; }
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableFinished) controller.abort(); });
    try {
      if (Number(request.headers['content-length']) > 4096) {
        request.resume();
        throw new CanvasRenderFailure("RENDER_SIZE_LIMIT", "Render request is too large.", 413);
      }
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) {
        throw new CanvasRenderFailure("INVALID_RENDER_OPTIONS", "Expected a JSON render request.", 400);
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) throw new CanvasRenderFailure("RENDER_SIZE_LIMIT", "Render request is too large.", 413);
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new CanvasRenderFailure("INVALID_RENDER_OPTIONS", "Invalid JSON render request.", 400); }
      const image = await renderer.render(request.headers.authorization, body, controller.signal);
      response.end(JSON.stringify(image));
    } catch (error) {
      const failure = error instanceof CanvasRenderFailure ? error : new CanvasRenderFailure("RENDER_FAILED", "Wiki canvas rendering failed.", 502);
      response.writeHead(failure.status);
      response.end(JSON.stringify({ error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  server.setTimeout(30_000, socket => socket.destroy());
  return server;
}

if (process.argv[1]?.endsWith('/canvasRenderServer.js')) {
  const renderer = new CanvasRenderer({ backendOrigin: process.env.AFFINE_RENDER_BACKEND_ORIGIN ?? 'http://affine-api:3010' });
  // No service credential or remotely supplied URL is accepted by this listener.
  const server = canvasRenderServer(renderer);
  server.listen(3100, '127.0.0.1');
  process.once('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
}
