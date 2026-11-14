import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import type { GraphQLClient } from "../graphqlClient.js";
import { boundedBody, CANVAS_LIMITS, canvasRenderSchema, canvasRenderShape } from "../canvasRenderPolicy.js";
import { toolError } from "../util/mcp.js";

const errorMessages: Record<string, string> = {
  AUTH_REQUIRED: "Your Wiki login expired or is invalid. Reconnect TaarInternal and retry.",
  ACCESS_DENIED: "You do not have access to this Wiki document.",
  DOCUMENT_NOT_FOUND: "Wiki document was not found.",
  FRAME_NOT_FOUND: "The requested Wiki frame was not found.",
  EMPTY_CANVAS: "Wiki document has no renderable canvas content.",
  STALE_DOCUMENT_REVISION: "Wiki document changed. Read its current revision and retry.",
  RENDER_BUSY: "Wiki renderer is busy; retry shortly.",
  RENDER_TIMEOUT: "Wiki rendering timed out. Try a smaller viewport.",
  RENDER_SIZE_LIMIT: "Wiki render exceeds its size limit. Try a smaller viewport or scale.",
  FRONTEND_CHANGED: "Wiki frontend changed during rendering; retry.",
  INVALID_RENDER_OPTIONS: "Invalid Wiki render options.",
  INVALID_DOCUMENT_SNAPSHOT: "Wiki document cannot be rendered.",
  RENDER_ASSET_FAILURE: "Wiki renderer could not load the deployed frontend assets.",
  RENDER_FAILED: "Wiki canvas rendering failed.",
};
const renderedImage = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/), currentRevision: z.string().regex(/^[a-f0-9]{64}$/),
  revisionConsistency: z.literal("immutable-snapshot-not-linearizable"),
  sourceUnchangedAtRecheck: z.boolean(), renderedAt: z.string().datetime(), frontendRevision: z.string().min(1).max(128),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict(),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), scale: z.number().min(1).max(2),
  frameId: z.string().max(128).nullable(), elementCount: z.number().int().positive(), warnings: z.array(z.string().max(512)).max(40),
  mimeType: z.literal("image/png"), data: z.string().max(Math.ceil(CANVAS_LIMITS.imageBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export function registerCanvasTools(server: McpServer, gql: GraphQLClient, enabled: boolean) {
  server.registerTool("render_canvas", {
    title: "Render Wiki Canvas",
    description: "Render the actual Wiki canvas as a PNG using your document permissions. Choose a frame, an explicit viewport, or automatic fit. Revision metadata identifies the rendered snapshot, not a linearizable read of concurrent edits.",
    inputSchema: canvasRenderShape,
  }, (async (raw: unknown) => {
    if (!enabled) return toolError("Wiki canvas rendering is not enabled on this deployment.", { code: "RENDER_UNAVAILABLE", recoveryGuidance: "Ask your Wiki administrator to enable the reviewed renderer deployment." });
    const parsed = canvasRenderSchema.safeParse(raw);
    if (!parsed.success) return toolError(errorMessages.INVALID_RENDER_OPTIONS, { code: "INVALID_RENDER_OPTIONS" });
    const auth = await gql.getConnectionAuth();
    if (!auth.bearer || auth.cookie) return toolError(errorMessages.AUTH_REQUIRED, { code: "auth_required" });
    try {
      const response = await fetch('http://127.0.0.1:3100/render', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.bearer}` },
        body: JSON.stringify(parsed.data), redirect: 'error', signal: AbortSignal.timeout(CANVAS_LIMITS.requestMs + 1000),
      });
      const body = JSON.parse((await boundedBody(response, 3 * 1024 * 1024)).toString('utf8'));
      if (!response.ok) {
        const code = typeof body?.error?.code === 'string' && Object.hasOwn(errorMessages, body.error.code) ? body.error.code : 'RENDER_FAILED';
        const currentRevision = body?.error?.details?.currentRevision;
        const publicCode = code === 'AUTH_REQUIRED' ? 'auth_required' : code === 'ACCESS_DENIED' ? 'access_denied' : code;
        return toolError(errorMessages[code], { code: publicCode, retryable: code === 'RENDER_BUSY',
          details: typeof currentRevision === 'string' && /^[a-f0-9]{64}$/.test(currentRevision) ? { currentRevision } : undefined,
          recoveryGuidance: code === 'STALE_DOCUMENT_REVISION' ? 'Read the document again and reconcile its revision before retrying.' : 'Check your Wiki access and render options, then retry.',
        });
      }
      const image = renderedImage.parse(body);
      const png = Buffer.from(image.data, 'base64');
      if (png.length < 24 || png.length > CANVAS_LIMITS.imageBytes || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        png.readUInt32BE(16) !== image.width || png.readUInt32BE(20) !== image.height ||
        image.width * image.height > CANVAS_LIMITS.pixels || image.frameId !== (parsed.data.frameId ?? null)) throw new Error('Invalid render response');
      if (image.width !== Math.round(parsed.data.width * parsed.data.scale) || image.height !== Math.round(parsed.data.height * parsed.data.scale) ||
        image.scale !== parsed.data.scale || (parsed.data.expectedRevision && image.revision !== parsed.data.expectedRevision)) throw new Error('Mismatched render response');
      const { data, ...metadata } = image;
      const structuredContent = { workspaceId: parsed.data.workspaceId, docId: parsed.data.docId, ...metadata,
        url: `https://wiki.taar.ltd/workspace/${parsed.data.workspaceId}/${parsed.data.docId}` };
      return { structuredContent, content: [
        { type: 'image' as const, mimeType: 'image/png', data },
        { type: 'text' as const, text: JSON.stringify(structuredContent) },
      ] };
    } catch {
      return toolError(errorMessages.RENDER_FAILED, { code: 'RENDER_FAILED', recoveryGuidance: 'Check your Wiki access and render options, then retry.' });
    }
  }) as any);
}
