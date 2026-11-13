#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";

import { DelegatedAffineAuth, runWithDelegatedAuth } from "../dist/delegatedAuth.js";

const requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ authorization: req.headers.authorization, body, url: req.url });

  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "https://example.com/token" }).end();
    return;
  }
  if (req.headers.authorization === "Bearer rejected-token") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_an_affine_member" }));
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const incoming = req.headers.authorization?.replace(/^Bearer /, "") || "missing";
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({
    access_token: `affine-${incoming}`,
    token_type: "Bearer",
    expires_in: 300,
  }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const auth = new DelegatedAffineAuth({
  baseUrl,
  exchangePath: "/exchange",
  timeoutMs: 1_000,
  cacheMaxEntries: 8,
});
const authInfo = (token, subject) => ({
  token,
  clientId: "chatgpt",
  scopes: ["mcp"],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  extra: { subject },
});

try {
  await assert.rejects(() => auth.ready(), /No authenticated MCP caller/);
  assert.throws(
    () => runWithDelegatedAuth(authInfo("token-without-subject", ""), () => undefined),
    /does not include a usable user identity/,
  );

  const [alice, bob] = await Promise.all([
    runWithDelegatedAuth(authInfo("alice-token", "alice"), () => auth.ready()),
    runWithDelegatedAuth(authInfo("bob-token", "bob"), () => auth.ready()),
  ]);
  assert.deepEqual(alice, { kind: "bearer", token: "affine-alice-token" });
  assert.deepEqual(bob, { kind: "bearer", token: "affine-bob-token" });

  const cachedAlice = await runWithDelegatedAuth(
    authInfo("alice-token", "alice"),
    () => auth.ready(),
  );
  assert.deepEqual(cachedAlice, alice);
  assert.equal(
    requests.filter((request) => request.authorization === "Bearer alice-token").length,
    1,
    "repeated calls must reuse the cached exchange",
  );

  const sameUserConcurrent = await Promise.all([
    runWithDelegatedAuth(authInfo("carol-token", "carol"), () => auth.ready()),
    runWithDelegatedAuth(authInfo("carol-token", "carol"), () => auth.ready()),
  ]);
  assert.deepEqual(sameUserConcurrent[0], sameUserConcurrent[1]);
  assert.equal(
    requests.filter((request) => request.authorization === "Bearer carol-token").length,
    1,
    "concurrent calls must share one in-flight exchange",
  );

  await assert.rejects(
    () => runWithDelegatedAuth(authInfo("rejected-token", "mallory"), () => auth.ready()),
    (error) => error?.code === "access_denied" && /HTTP 403/.test(error.message),
  );

  const redirectingAuth = new DelegatedAffineAuth({
    baseUrl,
    exchangePath: "/redirect",
    timeoutMs: 1_000,
  });
  await assert.rejects(
    () => runWithDelegatedAuth(authInfo("redirect-token", "redirect-user"), () => redirectingAuth.ready()),
    /redirect|fetch failed/i,
  );

  assert.throws(
    () => new DelegatedAffineAuth({
      baseUrl,
      exchangePath: "https://example.com/exchange",
      timeoutMs: 1_000,
    }),
    /must resolve to the configured AFFINE_BASE_URL origin/,
  );

  for (const request of requests.filter((entry) => entry.url === "/exchange")) {
    assert.deepEqual(JSON.parse(request.body), { audience: "affine-api" });
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("Delegated AFFiNE authentication tests passed");
