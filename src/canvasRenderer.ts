import { Worker } from "node:worker_threads";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { allowedRenderAsset, boundedBody, CANVAS_LIMITS, CanvasRenderFailure, canvasRenderSchema, renderBackendOrigin, type CanvasRenderInput } from "./canvasRenderPolicy.js";

type Viewport = { x: number; y: number; width: number; height: number };
type RenderedView = { viewport: Viewport; frameId: string | null; elementCount: number; warnings: string[] };
type BrowserFactory = () => Promise<Browser>;
export type CanvasImage = RenderedView & {
  revision: string; currentRevision: string; revisionConsistency: "immutable-snapshot-not-linearizable";
  sourceUnchangedAtRecheck: boolean; renderedAt: string; frontendRevision: string;
  width: number; height: number; scale: number; mimeType: "image/png"; data: string;
};

async function snapshotRevision(bytes: Buffer, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new CanvasRenderFailure("RENDER_TIMEOUT", "Wiki rendering timed out.", 504);
  const worker = new Worker(new URL("./canvasSnapshotWorker.js", import.meta.url), {
    workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  let cleanup = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const invalid = () => reject(new CanvasRenderFailure("INVALID_DOCUMENT_SNAPSHOT", "Wiki document cannot be rendered.", 422));
      const cancel = () => reject(new CanvasRenderFailure("RENDER_TIMEOUT", "Wiki rendering timed out.", 504));
      const timer = setTimeout(cancel, CANVAS_LIMITS.snapshotMs);
      cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      signal.addEventListener("abort", cancel, { once: true });
      worker.once("message", result => {
        cleanup();
        if (typeof result?.revision !== "string" || !/^[a-f0-9]{64}$/.test(result.revision)) invalid();
        else resolve(result.revision);
      });
      worker.once("error", () => { cleanup(); invalid(); });
      worker.once("exit", code => { if (code !== 0) { cleanup(); invalid(); } });
    });
  } finally { cleanup(); await worker.terminate(); }
}

const renderPolicy = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "media-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

export class CanvasRenderer {
  private active = 0;
  private readonly origin: string;
  constructor(options: { backendOrigin: string; maxConcurrency?: number; fetch?: typeof fetch; browserFactory?: BrowserFactory }) {
    this.origin = renderBackendOrigin(options.backendOrigin);
    this.options = options;
    if (!Number.isInteger(options.maxConcurrency ?? 1) || (options.maxConcurrency ?? 1) < 1 || (options.maxConcurrency ?? 1) > 2) throw new Error("Renderer concurrency must be one or two.");
  }
  private readonly options: { backendOrigin: string; maxConcurrency?: number; fetch?: typeof fetch; browserFactory?: BrowserFactory };

  async render(authorization: string | undefined, raw: unknown, cancellation?: AbortSignal): Promise<CanvasImage> {
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization ?? "") || authorization!.length > 16_400) {
      throw new CanvasRenderFailure("AUTH_REQUIRED", "Wiki authentication is required.", 401);
    }
    const parsed = canvasRenderSchema.safeParse(raw);
    if (!parsed.success) throw new CanvasRenderFailure("INVALID_RENDER_OPTIONS", "Invalid Wiki render dimensions, viewport, frame or revision.", 400);
    if (this.active >= (this.options.maxConcurrency ?? 1)) throw new CanvasRenderFailure("RENDER_BUSY", "Wiki renderer is busy; retry shortly.", 429);
    this.active++;
    const signal = AbortSignal.any([AbortSignal.timeout(CANVAS_LIMITS.requestMs), ...(cancellation ? [cancellation] : [])]);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let onAbort: (() => void) | undefined;
    let rendering: Promise<CanvasImage> | undefined;
    const task = async () => {
      const input = parsed.data;
      const snapshot = await this.readSnapshot(authorization!, input, signal);
      const revision = await snapshotRevision(snapshot, signal);
      if (input.expectedRevision && input.expectedRevision !== revision) throw this.stale(revision);
      if (signal.aborted) throw new CanvasRenderFailure("RENDER_TIMEOUT", "Wiki rendering timed out.", 504);
      const factory = this.options.browserFactory ?? (() => chromium.launch({
        headless: true, chromiumSandbox: true, timeout: 5000,
        args: ["--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      }));
      browser = await factory();
      if (signal.aborted) { await browser.close(); throw new Error("Cancelled"); }
      context = await browser.newContext({
        viewport: { width: input.width, height: input.height }, deviceScaleFactor: input.scale,
        serviceWorkers: "block", acceptDownloads: false, reducedMotion: "reduce", colorScheme: "light",
      });
      await context.routeWebSocket("**/*", socket => socket.close());
      let budget = 0;
      let requests = 0;
      let blocked = 0;
      let assetFailure = false;
      let frontendRevision = "";
      await context.route("**/*", async route => {
        const request = route.request();
        if (request.method() !== "GET" || !allowedRenderAsset(request.url(), this.origin)) { blocked++; await route.abort(); return; }
        if (++requests > CANVAS_LIMITS.assetRequests) { assetFailure = true; await route.abort(); return; }
        try {
          const response = await (this.options.fetch ?? fetch)(request.url(), { redirect: "error", signal, headers: { accept: "*/*" } });
          if (!response.ok) throw new Error("Missing asset");
          const bytes = await boundedBody(response, CANVAS_LIMITS.assetBytes, count => {
            // Charge concurrent streams before retaining their chunks in memory.
            budget += count;
            if (budget > CANVAS_LIMITS.totalAssetBytes) throw new Error("Asset budget");
          });
          const document = new URL(request.url()).pathname === "/internal/mcp-render";
          if (document) {
            frontendRevision = bytes.toString("utf8").match(/data-version="([a-zA-Z0-9._-]+)"/)?.[1] ?? "";
            if (!frontendRevision) throw new Error("Unversioned frontend");
          }
          await route.fulfill({ status: 200, body: bytes, headers: {
            "content-type": response.headers.get("content-type") ?? "application/octet-stream",
            "cache-control": "no-store", ...(document ? { "content-security-policy": renderPolicy } : {}),
          } });
        } catch { assetFailure = true; await route.abort().catch(() => undefined); }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(CANVAS_LIMITS.browserMs);
      await page.goto(`${this.origin}/internal/mcp-render`, { waitUntil: "domcontentloaded", timeout: CANVAS_LIMITS.browserMs });
      await page.waitForFunction(() => typeof (window as any).__TAAR_CANVAS_RENDER__ === "function");
      let view: RenderedView;
      try {
        view = await page.evaluate(async payload => {
          return (window as any).__TAAR_CANVAS_RENDER__(payload);
        }, { snapshotBase64: snapshot.toString("base64"), docId: input.docId, frameId: input.frameId, viewport: input.viewport, width: input.width, height: input.height }) as RenderedView;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/\bFRAME_NOT_FOUND\b/.test(message)) throw new CanvasRenderFailure('FRAME_NOT_FOUND', 'The requested Wiki frame was not found.', 404);
        if (/\bEMPTY_CANVAS\b/.test(message)) throw new CanvasRenderFailure('EMPTY_CANVAS', 'Wiki document has no renderable canvas content.', 422);
        if (/\bINVALID_SNAPSHOT\b/.test(message)) throw new CanvasRenderFailure('INVALID_DOCUMENT_SNAPSHOT', 'Wiki document cannot be rendered.', 422);
        if (/\bRENDER_TIMEOUT\b/.test(message)) throw new CanvasRenderFailure('RENDER_TIMEOUT', 'Wiki rendering timed out.', 504);
        throw new CanvasRenderFailure('RENDER_FAILED', 'Wiki canvas rendering failed.', 502);
      }
      if (!view || !Number.isSafeInteger(view.elementCount) || view.elementCount < 1 || !view.viewport ||
        ![view.viewport.x, view.viewport.y, view.viewport.width, view.viewport.height].every(Number.isFinite) ||
        view.viewport.width <= 0 || view.viewport.height <= 0 || view.frameId !== (input.frameId ?? null) ||
        !Array.isArray(view.warnings) || view.warnings.some(value => typeof value !== "string" || value.length > 512) || view.warnings.length > 32) {
        throw new CanvasRenderFailure("RENDER_FAILED", "Wiki canvas did not produce a valid rendered view.", 422);
      }
      if (assetFailure) throw new CanvasRenderFailure("RENDER_ASSET_FAILURE", "Wiki renderer could not load the deployed frontend assets.", 502);
      const png = await page.locator("#taar-canvas-render").screenshot({ type: "png", animations: "disabled", timeout: 5000 });
      if (png.length > CANVAS_LIMITS.imageBytes || png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new CanvasRenderFailure("RENDER_SIZE_LIMIT", "Rendered Wiki image exceeds its limit or is invalid.", 413);
      }
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      if (width !== Math.round(input.width * input.scale) || height !== Math.round(input.height * input.scale)) {
        throw new CanvasRenderFailure("RENDER_FAILED", "Rendered Wiki dimensions did not match the request.", 502);
      }
      // No image is released if permissions changed while Chromium was rendering.
      const current = await this.readSnapshot(authorization!, input, signal);
      const currentRevision = await snapshotRevision(current, signal);
      if (input.expectedRevision && revision !== currentRevision) throw this.stale(currentRevision);
      const check = await (this.options.fetch ?? fetch)(`${this.origin}/internal/mcp-render`, { redirect: "error", signal });
      const checkHtml = await boundedBody(check, 1024 * 1024);
      if (!check.ok || checkHtml.toString().match(/data-version="([a-zA-Z0-9._-]+)"/)?.[1] !== frontendRevision) {
        throw new CanvasRenderFailure("FRONTEND_CHANGED", "Wiki frontend changed during rendering; retry.", 409);
      }
      return {
        ...view, warnings: [
          ...view.warnings,
          "Rendered from an immutable snapshot. Access was rechecked, but this is not a linearizable read of concurrent edits.",
          ...(blocked ? ["External embeds and network-only resources were blocked."] : []),
          ...(revision !== currentRevision ? ["The source changed while rendering; this image shows the earlier revision."] : []),
        ],
        revision, currentRevision, revisionConsistency: "immutable-snapshot-not-linearizable" as const,
        sourceUnchangedAtRecheck: revision === currentRevision, renderedAt: new Date().toISOString(), frontendRevision,
        width, height, scale: input.scale, mimeType: "image/png" as const, data: png.toString("base64"),
      };
    };
    try {
      if (signal.aborted) throw new CanvasRenderFailure("RENDER_TIMEOUT", "Wiki rendering timed out.", 504);
      rendering = task();
      return await Promise.race([rendering, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new CanvasRenderFailure("RENDER_TIMEOUT", "Wiki rendering timed out.", 504));
        signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } catch (error) {
      if (error instanceof CanvasRenderFailure) throw error;
      throw new CanvasRenderFailure("RENDER_FAILED", "Wiki canvas rendering failed.", 502);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      // A cancelled launch may finish late; retain its slot until it closes.
      await rendering?.catch(() => undefined);
      this.active--;
    }
  }

  private stale(currentRevision: string) {
    return new CanvasRenderFailure("STALE_DOCUMENT_REVISION", "Wiki document changed. Read its current revision and retry.", 409, { currentRevision });
  }

  private async readSnapshot(authorization: string, input: CanvasRenderInput, signal: AbortSignal) {
    const response = await (this.options.fetch ?? fetch)(`${this.origin}/api/workspaces/${input.workspaceId}/docs/${input.docId}`, {
      headers: { authorization, accept: "application/octet-stream" }, redirect: "error", signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new CanvasRenderFailure("AUTH_REQUIRED", "Wiki authentication expired or is invalid.", 401);
      if (response.status === 403) throw new CanvasRenderFailure("ACCESS_DENIED", "You do not have access to this Wiki document.", 403);
      if (response.status === 404) throw new CanvasRenderFailure("DOCUMENT_NOT_FOUND", "Wiki document was not found.", 404);
      throw new CanvasRenderFailure("WIKI_UNAVAILABLE", "Wiki is temporarily unavailable.", 502);
    }
    return boundedBody(response, CANVAS_LIMITS.snapshotBytes);
  }
}
