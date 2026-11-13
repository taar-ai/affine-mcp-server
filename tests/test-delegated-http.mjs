#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort() {
  const server = http.createServer();
  const url = await listen(server);
  await close(server);
  return Number(new URL(url).port);
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
Object.assign(publicJwk, { alg: "RS256", kid: "delegated-http-test", use: "sig" });

let issuerBaseUrl = "";
const issuer = http.createServer((req, res) => {
  const send = (payload) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.url === "/.well-known/oauth-authorization-server" || req.url === "/.well-known/openid-configuration") {
    send({
      issuer: issuerBaseUrl,
      authorization_endpoint: `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
      jwks_uri: `${issuerBaseUrl}/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
    return;
  }
  if (req.url === "/jwks") {
    send({ keys: [publicJwk] });
    return;
  }
  res.writeHead(404).end();
});
issuerBaseUrl = await listen(issuer);

const affine = http.createServer(async (req, res) => {
  if (req.url === "/graphql") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { __typename: "Query" } }));
    return;
  }
  if (req.url === "/api/auth/taar/mcp/token") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "affine-test", token_type: "Bearer", expires_in: 300 }));
    return;
  }
  res.writeHead(404).end();
});
const affineBaseUrl = await listen(affine);

const port = await freePort();
const publicBaseUrl = `http://127.0.0.1:${port}`;
let stderr = "";
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: projectDirectory,
  env: {
    ...process.env,
    AFFINE_API_TOKEN: "",
    AFFINE_BACKEND_AUTH_MODE: "oauth_token_exchange",
    AFFINE_BASE_URL: affineBaseUrl,
    AFFINE_TOKEN_EXCHANGE_URL: `${affineBaseUrl}/api/auth/taar/mcp/token`,
    AFFINE_COOKIE: "",
    AFFINE_EMAIL: "",
    AFFINE_MCP_AUTH_MODE: "oauth",
    AFFINE_MCP_HTTP_HOST: "127.0.0.1",
    AFFINE_MCP_PUBLIC_BASE_URL: publicBaseUrl,
    AFFINE_OAUTH_ISSUER_URL: issuerBaseUrl,
    AFFINE_OAUTH_SCOPES: "mcp",
    AFFINE_PASSWORD: "",
    MCP_TRANSPORT: "http",
    PORT: String(port),
    XDG_CONFIG_HOME: `/tmp/affine-delegated-http-${process.pid}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function waitForHealth() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited early: ${stderr}`);
    try {
      const response = await fetch(`${publicBaseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`MCP server did not become healthy: ${stderr}`);
}

async function mintToken(subject, claims = {}) {
  return await new SignJWT({ scope: "mcp", client_id: "gateway", email_verified: true, token_type: "access", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: String(publicJwk.kid) })
    .setIssuer(issuerBaseUrl)
    .setSubject(subject)
    .setAudience(`${publicBaseUrl}/mcp`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const headers = (token, sessionId) => ({
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

try {
  await waitForHealth();
  const health = await fetch(`${publicBaseUrl}/healthz`).then((response) => response.json());
  assert.equal(health.backendAuthMode, "oauth_token_exchange");

  const aliceToken = await mintToken("alice");
  const initialize = await fetch(`${publicBaseUrl}/mcp`, {
    method: "POST",
    headers: headers(aliceToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "delegated-http-test", version: "1.0.0" },
      },
    }),
  });
  const initializeBody = await initialize.text();
  assert.equal(initialize.status, 200, initializeBody);
  const sessionId = initialize.headers.get("mcp-session-id");
  assert(sessionId, "initialize response must include an MCP session ID");

  const bobToken = await mintToken("bob");
  for (const method of ["GET", "DELETE"]) {
    const result = await fetch(`${publicBaseUrl}/mcp`, { method, headers: headers(bobToken, sessionId) });
    assert.equal(result.status, 403, `${method} cannot access another principal session`);
    await result.arrayBuffer();
  }
  for (const claims of [{email_verified:false},{email_verified:"true"},{email_verified:undefined},{token_type:"id"},{token_type:undefined}]) {
    const result = await fetch(`${publicBaseUrl}/mcp`, { method:"POST", headers:headers(await mintToken("alice", claims), sessionId), body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}) });
    assert.equal(result.status, 401);
    await result.arrayBuffer();
  }
  const crossUser = await fetch(`${publicBaseUrl}/mcp`, {
    method: "POST",
    headers: headers(bobToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(crossUser.status, 403);
  assert.match(await crossUser.text(), /different authenticated user/);

  const sameUser = await fetch(`${publicBaseUrl}/mcp`, {
    method: "POST",
    headers: headers(aliceToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const sameUserBody = await sameUser.text();
  assert.equal(sameUser.status, 202, sameUserBody);
  const refreshed = await fetch(`${publicBaseUrl}/mcp`, {
    method: "POST", headers: headers(await mintToken("alice", { jti: "refreshed-fixture" }), sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(refreshed.status, 202, "a refreshed bearer for the same verified issuer/subject can retain its session");
  await refreshed.arrayBuffer();

  const forbidden = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDirectory,
    env: { ...process.env, AFFINE_BASE_URL: affineBaseUrl, AFFINE_BACKEND_AUTH_MODE: "oauth_token_exchange",
      AFFINE_MCP_AUTH_MODE: "oauth", AFFINE_API_TOKEN: "forbidden-service-fixture", MCP_TRANSPORT: "http",
      XDG_CONFIG_HOME: `/tmp/affine-forbidden-service-${process.pid}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let forbiddenStderr = "";
  forbidden.stderr.on("data", chunk => { forbiddenStderr += chunk; });
  const deadline = setTimeout(() => forbidden.kill("SIGKILL"), 3000);
  const code = await new Promise(resolve => forbidden.once("exit", resolve));
  clearTimeout(deadline);
  assert.notEqual(code, 0);
  assert.match(forbiddenStderr, /cannot be combined with AFFINE_API_TOKEN/);
  assert(!forbiddenStderr.includes("forbidden-service-fixture"));
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3_000).then(() => child.kill("SIGKILL")),
    ]);
  }
  await Promise.all([close(issuer), close(affine)]);
}

console.log("Delegated OAuth HTTP session binding tests passed");
