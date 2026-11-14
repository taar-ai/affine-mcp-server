// Run on stdin in the renderer container. Only static assets reach the real API;
// document reads and identities below are synthetic, request-local fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import * as Y from 'yjs';
import { CanvasRenderer } from './dist/canvasRenderer.js';

const origin = process.env.AFFINE_RENDER_BACKEND_ORIGIN ?? 'http://affine-api:3010';
const authA = 'Bearer synthetic_a.test.signature';
const authB = 'Bearer synthetic_b.test.signature';
function snapshot(label, color) {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  const block = (id, flavour, version, children, props) => blocks.set(id, new Y.Map(Object.entries({
    'sys:id': id, 'sys:flavour': flavour, 'sys:version': version,
    'sys:children': Y.Array.from(children), ...props,
  })));
  block('root', 'affine:page', 2, ['surface'], { 'prop:title': new Y.Text('Synthetic render acceptance') });
  const elements = new Y.Map();
  block('surface', 'affine:surface', 5, ['frame'], {
    'prop:elements': new Y.Map([['type', '$blocksuite:internal:native$'], ['value', elements]]),
  });
  block('frame', 'affine:frame', 1, [], {
    'prop:xywh': '[0,0,900,500]', 'prop:title': new Y.Text('Acceptance frame'), 'prop:index': 'a0',
    'prop:rotate': 0, 'prop:background': 'transparent', 'prop:presentationIndex': 'a0',
    'prop:lockedBySelf': false, 'prop:childElementIds': new Y.Map([['left', true], ['right', true], ['connector', true]]),
  });
  for (const [id, x, text] of [['left', 80, label], ['right', 600, 'Target']]) {
    elements.set(id, new Y.Map(Object.entries({
      id, type: 'shape', xywh: `[${x},160,240,120]`, index: id === 'left' ? 'a1' : 'a2',
      shapeType: 'rect', shapeStyle: 'General', radius: 0, roughness: 1, seed: 1,
      strokeStyle: 'solid', shadow: null, textResizing: 1, fontFamily: 'blocksuite:surface:Inter',
      fontSize: 24, fontWeight: '400', fontStyle: 'normal', textAlign: 'center',
      textHorizontalAlign: 'center', textVerticalAlign: 'center', padding: [10, 20], maxWidth: false,
      filled: true, fillColor: color, strokeColor: '#1b5741', strokeWidth: 3, rotate: 0, text: new Y.Text(text),
    })));
  }
  elements.set('connector', new Y.Map(Object.entries({
    id: 'connector', type: 'connector', index: 'a3', xywh: '[320,220,280,1]',
    source: { id: 'left', position: [1, 0.5] }, target: { id: 'right', position: [0, 0.5] },
    mode: 0, seed: 2, roughness: 1, strokeStyle: 'solid', frontEndpointStyle: 'None', rearEndpointStyle: 'Arrow',
    labelDisplay: true, labelOffset: { distance: 0.5, anchor: 'center' }, labelConstraints: { hasMaxWidth: true, maxWidth: 280 },
    labelStyle: { color: '#111111', fontFamily: 'blocksuite:surface:Inter', fontSize: 16, fontWeight: '400', fontStyle: 'normal', textAlign: 'center' },
    labelXYWH: [385, 190, 150, 25], stroke: '#1b5741', strokeWidth: 3, text: new Y.Text('Connector label'),
  })));
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
}
const fixtures = { alpha: snapshot('Identity A', '#b8e5d2'), beta: snapshot('Identity B', '#f5cad2') };
function renderer({ revoke = false, maxConcurrency = 1 } = {}) {
  let reads = 0, assets = 0;
  return { instance: new CanvasRenderer({ backendOrigin: origin, maxConcurrency,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/api/')) {
        const id = parsed.pathname.split('/').at(-1);
        reads++;
        const allowed = parsed.pathname === `/api/workspaces/synthetic/docs/${id}` &&
          ((id === 'alpha' && init.headers.authorization === authA) || (id === 'beta' && init.headers.authorization === authB));
        if (!allowed || (revoke && reads > 1)) return new Response('denied', { status: 403 });
        return new Response(fixtures[id]);
      }
      assert.equal(init?.headers?.authorization, undefined, 'No credential may reach real frontend assets');
      assets++;
      return fetch(url, init);
    },
  }), count: () => ({ reads, assets }) };
}

function pixelCounts(image) {
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert([2, 6].includes(png[25]));
  assert.equal(png[28], 0);
  const channels = png[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: 4 * 1024 * 1024 });
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let green = 0, pink = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  for (let i = 0; i < pixels.length; i += channels) {
    if (pixels[i] === 184 && pixels[i + 1] === 229 && pixels[i + 2] === 210) green++;
    if (pixels[i] === 245 && pixels[i + 1] === 202 && pixels[i + 2] === 210) pink++;
  }
  return { width, height, green, pink, sha256: createHash('sha256').update(png).digest('hex') };
}

const input = { workspaceId: 'synthetic', docId: 'alpha', width: 640, height: 480 };
const first = renderer();
const a = await first.instance.render(authA, input);
const ap = pixelCounts(a);
assert(ap.green > 1000 && ap.pink === 0, 'Expected real nonblank green canvas pixels');
assert.equal(a.sourceUnchangedAtRecheck, true);
assert.equal(a.revision, a.currentRevision);
assert.equal(first.count().reads, 2);
assert(first.count().assets > 0);
await assert.rejects(first.instance.render(authA, { ...input, docId: 'beta' }), error => error.code === 'ACCESS_DENIED');
await assert.rejects(first.instance.render(authA, { ...input, expectedRevision: 'f'.repeat(64) }), error => error.code === 'STALE_DOCUMENT_REVISION');
await assert.rejects(first.instance.render(authA, { ...input, frameId: 'missing' }), error => error.code === 'FRAME_NOT_FOUND');
const frame = await first.instance.render(authA, { ...input, frameId: 'frame', expectedRevision: a.revision });
assert.equal(frame.frameId, 'frame');
assert(pixelCounts(frame).green > 1000);
const mobile = await first.instance.render(authA, { ...input, width: 390, height: 640 });
assert.equal(pixelCounts(mobile).width, 390);
assert(pixelCounts(mobile).green > 1000);
const revoked = renderer({ revoke: true });
await assert.rejects(revoked.instance.render(authA, input), error => error.code === 'ACCESS_DENIED');
const simultaneous = renderer({ maxConcurrency: 2 });
const [again, b] = await Promise.all([
  simultaneous.instance.render(authA, input),
  simultaneous.instance.render(authB, { ...input, docId: 'beta' }),
]);
const againPixels = pixelCounts(again), bp = pixelCounts(b);
assert(againPixels.green > 1000 && againPixels.pink === 0);
assert(bp.pink > 1000 && bp.green === 0);
assert.notEqual(againPixels.sha256, bp.sha256);
assert.notEqual(again.revision, b.revision);
console.log(JSON.stringify({ ok: true, frontendRevision: a.frontendRevision, desktop: ap, mobile: { width: mobile.width, height: mobile.height },
  frame: true, malformedFrame: true, staleRevision: true, mockAccessDenial: true, mockRevocation: true,
  concurrentSyntheticIdentitiesIsolated: true, nativeProductionAclTest: false, assetsWithoutCredentials: true,
  revisionConsistency: a.revisionConsistency }));
