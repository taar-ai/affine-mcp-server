import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { CanvasRenderer } from '../dist/canvasRenderer.js';
import { allowedRenderAsset, boundedBody, CANVAS_LIMITS, canvasRenderSchema } from '../dist/canvasRenderPolicy.js';
import { registerCanvasTools } from '../dist/tools/canvas.js';
import { canvasRenderServer } from '../dist/canvasRenderServer.js';

const origin = 'http://wiki-api.test';
const input = { workspaceId: 'workspace', docId: 'document' };
const authA = 'Bearer user_a.jwt.signature', authB = 'Bearer user_b.jwt.signature';
function document(label) {
  const doc = new Y.Doc();
  const root = new Y.Map(); doc.getMap('blocks').set('root', root);
  root.set('sys:flavour', 'affine:page'); root.set('prop:title', label);
  const result = Y.encodeStateAsUpdate(doc); doc.destroy(); return result;
}
const first = document('first'), second = document('second');
// Synthetic IHDR only: browser behavior is mocked here, not visual rendering.
function mockPng(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
function setup(options = {}) {
  const contexts = [], seen = [], payloads = [];
  let docReads = 0, launches = 0;
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('/api/workspaces/')) {
      docReads++;
      if ((init.headers.authorization !== authA && !(options.allowB && init.headers.authorization === authB)) || (options.revoke && docReads > 1)) return new Response('private details must not escape', { status: 403 });
      return new Response(options.invalidSnapshot ? Buffer.from('invalid') : init.headers.authorization === authB || options.changed && docReads > 1 ? second : first);
    }
    assert.equal(init?.headers?.authorization, undefined, 'No credential may reach frontend assets');
    return new Response('<div id="app" data-version="deployed-revision"></div>', { headers: { 'content-type': 'text/html' } });
  };
  const factory = async () => {
    launches++;
    const browser = { closed: false, async close() { this.closed = true; }, async newContext(configuration) {
      assert.equal(configuration.storageState, undefined); assert.equal(configuration.extraHTTPHeaders, undefined);
      assert.equal(configuration.serviceWorkers, 'block'); assert.equal(configuration.acceptDownloads, false);
      const context = { closed: false, configuration, async close() { this.closed = true; },
        async routeWebSocket(_pattern, callback) { let closed = false; callback({ close() { closed = true; } }); assert.ok(closed); },
        async route(_pattern, handler) { this.handler = handler; },
        async newPage() { return {
          setDefaultTimeout() {},
          async goto(url) { await context.handler({ request: () => ({ method: () => 'GET', url: () => url }), async fulfill() {}, async abort() { throw new Error('Unexpected document abort'); } }); },
          async waitForFunction() {},
          async evaluate(_function, payload) {
            assert.ok(!JSON.stringify(payload).includes('jwt.signature'));
            payloads.push(payload);
            if (options.onEvaluate) await options.onEvaluate(payload);
            return { viewport: payload.viewport ?? { x: 0, y: 0, width: 100, height: 100 }, frameId: payload.frameId ?? null, elementCount: 3, warnings: [] };
          },
          locator(selector) { assert.equal(selector, '#taar-canvas-render'); return { async screenshot() { return mockPng(Math.round(configuration.viewport.width * configuration.deviceScaleFactor), Math.round(configuration.viewport.height * configuration.deviceScaleFactor)); } }; },
        }; },
      };
      contexts.push({ context, browser }); return context;
    } };
    return browser;
  };
  return { renderer: new CanvasRenderer({ backendOrigin: origin, fetch: fetcher, browserFactory: factory, maxConcurrency: options.maxConcurrency }),
    contexts, seen, payloads, get launches() { return launches; } };
}

test('render request limits and asset routes reject identity injection, SSRF and oversized images', () => {
  for (const value of [{ ...input, userId: 'other' }, { ...input, docId: '../secret' }, { ...input, frameId: 'frame', viewport: { x: 0, y: 0, width: 1, height: 1 } },
    { ...input, width: 2048, height: 2048, scale: 2 }, { ...input, scale: NaN }, { ...input, viewport: { x: Infinity, y: 0, width: 1, height: 1 } }]) {
    assert.equal(canvasRenderSchema.safeParse(value).success, false);
  }
  for (const path of ['/internal/mcp-render', '/js/index.123.js', '/fonts/local.woff2', '/styles.1056fe91.css', '/vendor.838e270b.css', '/npm-async-@vanilla-extract.ab12cd34.css']) assert.ok(allowedRenderAsset(origin + path, origin));
  for (const url of ['http://attacker.test/js/a.js', origin + '/graphql', origin + '/api/workspaces/x/docs/y', origin + '/js/a.js?credential=x', 'file:///secret', origin + '/js/%2fapi.js']) {
    assert.equal(allowedRenderAsset(url, origin), false);
  }
});

test('actual snapshots are authorized twice and rendered without credentials in a fresh browser', async () => {
  const fixture = setup();
  const image = await fixture.renderer.render(authA, input);
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.width, 1200); assert.equal(image.height, 800);
  assert.equal(image.sourceUnchangedAtRecheck, true); assert.equal(image.revision, image.currentRevision);
  assert.equal(image.revisionConsistency, 'immutable-snapshot-not-linearizable'); assert.equal(image.frontendRevision, 'deployed-revision');
  assert.equal(fixture.seen.filter(value => value.url.includes('/api/workspaces/')).length, 2);
  assert.ok(fixture.contexts.every(value => value.context.closed && value.browser.closed));
  assert.equal(fixture.payloads[0].snapshotBase64, Buffer.from(first).toString('base64'));
  await assert.rejects(fixture.renderer.render(authB, input), error => error.code === 'ACCESS_DENIED' && !error.message.includes('private details'));
  assert.equal(fixture.launches, 1, 'Denied users must not launch a browser or read rendered output');
});

test('access revocation during render discards image and stale revisions fail before rendering', async () => {
  const revoked = setup({ revoke: true });
  await assert.rejects(revoked.renderer.render(authA, input), error => error.code === 'ACCESS_DENIED');
  assert.ok(revoked.contexts.every(value => value.context.closed && value.browser.closed));
  const stale = setup();
  await assert.rejects(stale.renderer.render(authA, { ...input, expectedRevision: 'f'.repeat(64) }), error => error.code === 'STALE_DOCUMENT_REVISION' && /^[a-f0-9]{64}$/.test(error.details.currentRevision));
  assert.equal(stale.launches, 0);
  const changed = setup({ changed: true });
  const rendered = await changed.renderer.render(authA, input);
  assert.equal(rendered.sourceUnchangedAtRecheck, false); assert.notEqual(rendered.revision, rendered.currentRevision);
  const strict = setup({ changed: true });
  await assert.rejects(strict.renderer.render(authA, { ...input, expectedRevision: rendered.revision }), error => error.code === 'STALE_DOCUMENT_REVISION');
});

test('concurrency is bounded and concurrent identities cannot reuse browser contexts', async () => {
  const release = [];
  const fixture = setup({ maxConcurrency: 2, allowB: true, onEvaluate: () => new Promise(resolve => release.push(resolve)) });
  const a = fixture.renderer.render(authA, input);
  const b = fixture.renderer.render(authB, { ...input, docId: 'another-document' });
  const deadline = Date.now() + 5000;
  while (release.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(release.length, 2);
  await assert.rejects(fixture.renderer.render(authA, input), error => error.code === 'RENDER_BUSY');
  assert.notEqual(fixture.contexts[0].context, fixture.contexts[1].context);
  assert.deepEqual(new Set(fixture.payloads.map(value => value.snapshotBase64)), new Set([Buffer.from(first).toString('base64'), Buffer.from(second).toString('base64')]));
  release.forEach(resolve => resolve()); await a; await b;
  assert.ok(fixture.contexts.every(value => value.context.closed && value.browser.closed));
});

test('malformed snapshots and response stream limits fail closed', async () => {
  const fixture = setup({ invalidSnapshot: true });
  await assert.rejects(fixture.renderer.render(authA, input), error => error.code === 'INVALID_DOCUMENT_SNAPSHOT');
  assert.equal(fixture.launches, 0);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedBody(new Response(stream), 5), error => error.code === 'RENDER_SIZE_LIMIT'); assert.ok(cancelled);
});

test('cancelled launches retain their concurrency slot until the late browser closes', async () => {
  let release, started;
  const launching = new Promise(resolve => { started = resolve; });
  let closed = false;
  const fixture = new CanvasRenderer({ backendOrigin: origin,
    fetch: async () => new Response(first),
    browserFactory: async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { async close() { closed = true; } };
    },
  });
  const controller = new AbortController();
  const pending = fixture.render(authA, input, controller.signal);
  const rejected = assert.rejects(pending, error => error.code === 'RENDER_TIMEOUT');
  await launching;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(fixture.render(authA, input), error => error.code === 'RENDER_BUSY');
  release();
  await rejected;
  assert.equal(closed, true);
});

test('MCP returns actual image content, safe metadata and no backend error detail', async () => {
  let handler;
  const server = { registerTool(name, _schema, callback) { assert.equal(name, 'render_canvas'); handler = callback; } };
  const fixture = setup(); const image = await fixture.renderer.render(authA, input);
  let current = { bearer: authA.slice(7), cookie: '' };
  const gql = { async getConnectionAuth() { return current; } };
  const original = globalThis.fetch;
  try {
    registerCanvasTools(server, gql, false);
    assert.equal((await handler(input)).structuredContent.code, 'RENDER_UNAVAILABLE');
    registerCanvasTools(server, gql, true);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3100/render'); assert.equal(options.headers.authorization, authA);
      assert.equal(options.redirect, 'error'); return Response.json(image);
    };
    const result = await handler(input); assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/png'); assert.equal(result.structuredContent.url, 'https://wiki.taar.ltd/workspace/workspace/document');
    assert.ok(!JSON.stringify(result).includes(authA));
    globalThis.fetch = async () => Response.json({ error: { code: 'ACCESS_DENIED', message: authA + ' http://private-api:3010/secret' } }, { status: 403 });
    const denied = await handler(input); assert.equal(denied.structuredContent.code, 'access_denied');
    assert.ok(!JSON.stringify(denied).includes(authA)); assert.ok(!JSON.stringify(denied).includes('private-api'));
    current = { bearer: '', cookie: 'shared-cookie' };
    assert.equal((await handler(input)).structuredContent.code, 'auth_required');
  } finally { globalThis.fetch = original; }
});

test('HTTP listener rejects malformed content, oversized requests and missing credentials without logging', async () => {
  const fixture = setup(); const server = canvasRenderServer(fixture.renderer);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/render`;
  try {
    const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authA }, body: 'invalid' });
    assert.equal(bad.status, 400);
    const large = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authA }, body: ' '.repeat(4097) });
    assert.equal(large.status, 413);
    assert.equal(fixture.launches, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('renderer success and denial never log tokens, authorization headers or document content', async () => {
  const logs = [];
  const originals = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, console[name]]));
  try {
    for (const name of Object.keys(originals)) console[name] = (...values) => logs.push(values.join(' '));
    const fixture = setup();
    await fixture.renderer.render(authA, input);
    await assert.rejects(fixture.renderer.render(authB, input), error => error.code === 'ACCESS_DENIED');
  } finally {
    for (const [name, value] of Object.entries(originals)) console[name] = value;
  }
  const output = logs.join('\n');
  assert.equal(output.includes(authA), false);
  assert.equal(output.includes(authB), false);
  assert.equal(/authorization|private details|Synthetic canvas/i.test(output), false);
  assert.equal(logs.length, 0);
});
