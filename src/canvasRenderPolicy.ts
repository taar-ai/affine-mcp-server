import { z } from "zod/v3";

export const CANVAS_LIMITS = Object.freeze({
  snapshotBytes: 8 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  assetBytes: 16 * 1024 * 1024,
  totalAssetBytes: 64 * 1024 * 1024,
  assetRequests: 256,
  requestMs: 25_000,
  browserMs: 15_000,
  snapshotMs: 3_000,
  pixels: 4_000_000,
});

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const canvasRenderShape = {
  workspaceId: id,
  docId: id,
  frameId: id.optional(),
  viewport: z.object({
    x: z.number().finite().min(-1e7).max(1e7),
    y: z.number().finite().min(-1e7).max(1e7),
    width: z.number().finite().positive().max(1e7),
    height: z.number().finite().positive().max(1e7),
  }).strict().optional(),
  width: z.number().int().min(256).max(2048).default(1200),
  height: z.number().int().min(256).max(2048).default(800),
  scale: z.number().min(1).max(2).default(1),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};
export const canvasRenderSchema = z.object(canvasRenderShape).strict().superRefine((input, context) => {
  if (input.frameId && input.viewport) context.addIssue({ code: "custom", message: "Choose either frameId or viewport." });
  if (input.width * input.height * input.scale ** 2 > CANVAS_LIMITS.pixels) {
    context.addIssue({ code: "custom", message: "Requested image exceeds the pixel budget." });
  }
});
export type CanvasRenderInput = z.infer<typeof canvasRenderSchema>;

export class CanvasRenderFailure extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export function renderBackendOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Renderer requires a fixed Wiki origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

export function allowedRenderAsset(value: string, origin: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) return false;
  if (url.pathname === "/internal/mcp-render") return true;
  if (/^\/(?:styles|vendor|npm-async-@vanilla-extract)\.[a-f0-9]+\.css$/.test(url.pathname)) return true;
  return /^\/(?:js|css|fonts|assets)\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|otf|png|webp|svg)$/.test(url.pathname);
}

export async function boundedBody(response: Response, maximum: number, consume?: (bytes: number) => void): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new CanvasRenderFailure("RENDER_SIZE_LIMIT", "Wiki render input exceeds its size limit.", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > maximum) throw new CanvasRenderFailure("RENDER_SIZE_LIMIT", "Wiki render input exceeds its size limit.", 413);
      consume?.(next.value.byteLength);
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
