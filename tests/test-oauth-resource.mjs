import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildOAuthProtectedResourceMetadata, getOAuthResourceUrl, validateOAuthConfig, verifyOAuthAccessToken } from "../dist/oauth.js";
import { createHttpAuthState, registerHttpAuthRoutes } from "../dist/httpAuth.js";

const configDirectory = await mkdtemp(join(tmpdir(), "affine-resource-fixture-"));
process.env.XDG_CONFIG_HOME = configDirectory;
const { loadConfig } = await import("../dist/config.js");
// All identities, signing keys and the tunnel URL are local fixture data only.
const resourceUrl = "https://tunnel.example.test/v1/mcp/tunnel_fixture";
const publicBaseUrl = "https://internal.example.test";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "resource-fixture", alg: "RS256" };
let issuerUrl;
const issuer = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  res.end(JSON.stringify({ issuer: issuerUrl, jwks_uri: `${issuerUrl}/jwks`,
    authorization_endpoint: `${issuerUrl}/authorize`, token_endpoint: `${issuerUrl}/token`, response_types_supported: ["code"] }));
});
await new Promise(resolve => issuer.listen(0, "127.0.0.1", resolve));
issuerUrl = `http://127.0.0.1:${issuer.address().port}`;
const oauthConfig = { publicBaseUrl, resourceUrl, issuerUrl, scopes: ["mcp"], clockSkewSeconds: 1 };
const mint = aud => new SignJWT({ scope: "mcp", aud })
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
  .setIssuer(issuerUrl).setSubject("local-fixture-user").setExpirationTime("2m").sign(privateKey);
let listener;
try {
  validateOAuthConfig(oauthConfig, { allowAnyOrigin: false });
  Object.assign(process.env, {
    AFFINE_MCP_AUTH_MODE: "oauth", AFFINE_MCP_PUBLIC_BASE_URL: publicBaseUrl,
    AFFINE_OAUTH_ISSUER_URL: issuerUrl, AFFINE_OAUTH_SCOPES: "mcp", AFFINE_OAUTH_RESOURCE_URL: resourceUrl,
  });
  assert.equal(loadConfig().oauthResourceUrl, resourceUrl);
  for (const invalid of ["", "http://tunnel.example.test/v1/mcp/id", "https://user:pass@tunnel.example.test/v1/mcp/id",
    `${resourceUrl}?x=1`, `${resourceUrl}?`, `${resourceUrl}#fragment`, `${resourceUrl}#`,
    "https://*.example.test/v1/mcp/id", `${resourceUrl}*`, `${resourceUrl}%2A`, ` ${resourceUrl}`,
    "https://TUNNEL.example.test/v1/mcp/id", "https://tunnel.example.test:443/v1/mcp/id"]) {
    process.env.AFFINE_OAUTH_RESOURCE_URL = invalid;
    assert.throws(() => loadConfig(), /AFFINE_OAUTH_RESOURCE_URL/);
    assert.throws(() => validateOAuthConfig({ ...oauthConfig, resourceUrl: invalid }, { allowAnyOrigin: false }), /AFFINE_OAUTH_RESOURCE_URL/);
  }
  process.env.AFFINE_OAUTH_RESOURCE_URL = resourceUrl;
  assert.equal(getOAuthResourceUrl(publicBaseUrl, resourceUrl), resourceUrl);
  assert.equal(getOAuthResourceUrl(publicBaseUrl, `${resourceUrl}/`), `${resourceUrl}/`);
  assert.equal(buildOAuthProtectedResourceMetadata(oauthConfig).resource, resourceUrl);
  const state = createHttpAuthState(loadConfig(), { allowAnyOrigin: false });
  const app = express();
  registerHttpAuthRoutes(app, state, (_req, _res, next) => next());
  app.get("/probe", state.authMiddleware, (req, res) => res.json({ resource: req.auth.resource.href, subject: req.auth.extra.subject }));
  listener = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  for (const route of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).resource, resourceUrl);
  }
  const accepted = await mint(resourceUrl);
  assert.equal((await verifyOAuthAccessToken(accepted, oauthConfig)).subject, "local-fixture-user");
  const response = await fetch(`${base}/probe`, { headers: { Authorization: `Bearer ${accepted}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { resource: resourceUrl, subject: "local-fixture-user" });
  for (const denied of [publicBaseUrl, `${publicBaseUrl}/mcp`, `${resourceUrl}/`, `${resourceUrl}/mcp`,
    "https://tunnel.example.test/v1/mcp/tunnel_other", [resourceUrl], [resourceUrl, `${publicBaseUrl}/mcp`],
    [`${publicBaseUrl}/mcp`, resourceUrl], [], undefined]) {
    const token = await mint(denied);
    await assert.rejects(verifyOAuthAccessToken(token, oauthConfig));
    const result = await fetch(`${base}/probe`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.status, 401, `audience rejected: ${JSON.stringify(denied)}`);
    await result.arrayBuffer();
  }
  console.log("Exact OAuth resource tests passed: config, external metadata/local aliases, request AuthInfo, strict string audience, no internal or multi-audience alternatives.");
} finally {
  for (const server of [listener, issuer].filter(Boolean)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(configDirectory, { recursive: true, force: true });
}
