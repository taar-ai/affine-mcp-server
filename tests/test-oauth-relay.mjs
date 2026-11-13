import assert from "node:assert/strict";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { probeOAuthReadiness, validateOAuthConfig, verifyOAuthAccessToken } from "../dist/oauth.js";

// These identities and keys exist only in this local fixture.
const issuer = "https://issuer.example.test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256", use: "sig" };
let mode = "redirect-metadata";
const requests = [];
const server = createServer((request, response) => {
  requests.push({ path: request.url, authorization: request.headers.authorization });
  if ((mode === "redirect-metadata" && request.url === "/metadata")
    || (mode === "redirect-jwks" && request.url === "/jwks")) {
    response.writeHead(302, { location: "https://forbidden.example.test" }).end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/metadata") {
    if (mode === "unavailable") {
      response.writeHead(503).end("{}");
      return;
    }
    response.end(JSON.stringify({
      issuer: mode === "wrong-issuer" ? "https://wrong.example.test" : issuer,
      jwks_uri: mode === "wrong-jwks" ? "https://wrong.example.test/keys" : `${issuer}/.well-known/jwks.json`,
    }));
  } else if (request.url === "/jwks") {
    response.end(JSON.stringify({ keys: [jwk] }));
  } else {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const relay = `http://127.0.0.1:${server.address().port}`;
const config = {
  issuerUrl: issuer,
  publicBaseUrl: "https://resource.example.test",
  scopes: ["openid", "email", "profile"],
  clockSkewSeconds: 1,
  metadataRelayBaseUrl: relay,
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input).origin, relay, "no direct issuer or arbitrary egress");
  assert.equal(init?.redirect, "error", "redirects must fail closed");
  return nativeFetch(input, init);
};
const token = (claims = {}) => new SignJWT({ scope: "openid email profile", ...claims })
  .setProtectedHeader({ alg: "RS256", kid: "fixture" })
  .setIssuer(claims.iss ?? issuer)
  .setSubject("local-fixture-user")
  .setAudience(claims.aud ?? `${config.publicBaseUrl}/mcp`)
  .setExpirationTime(claims.exp ?? "2m")
  .sign(privateKey);
try {
  validateOAuthConfig(config, { allowAnyOrigin: false });
  for (const url of ["http://external.example.test", `${relay}/path`, `${relay}?x=1`, "https://user:password@relay.example.test"]) {
    assert.throws(() => validateOAuthConfig({ ...config, metadataRelayBaseUrl: url }, { allowAnyOrigin: false }));
  }
  validateOAuthConfig({ ...config, metadataRelayBaseUrl: "http://relay.ns.svc.cluster.local:8080" }, { allowAnyOrigin: false });
  validateOAuthConfig({ ...config, metadataRelayBaseUrl: "http://affine-taar-jwks:8080" }, { allowAnyOrigin: false });
  assert.throws(() => validateOAuthConfig({ ...config, metadataRelayBaseUrl: "http://affine-taar-jwks:8081" }, { allowAnyOrigin: false }));
  assert.throws(() => validateOAuthConfig({ ...config, publicBaseUrl: "http://affine-mcp.ns.svc.cluster.local" }, { allowAnyOrigin: false }), /HTTPS/);
  await assert.rejects(probeOAuthReadiness(config));
  mode = "wrong-issuer";
  await assert.rejects(probeOAuthReadiness(config), /issuer does not match/);
  mode = "wrong-jwks";
  await assert.rejects(probeOAuthReadiness(config), /pinned issuer JWKS/);
  mode = "unavailable";
  await assert.rejects(probeOAuthReadiness(config), /503/);
  mode = "redirect-jwks";
  const readiness = await probeOAuthReadiness(config);
  assert.equal(readiness.issuer, issuer);
  assert.equal(readiness.jwksUri, `${issuer}/.well-known/jwks.json`);
  await assert.rejects(verifyOAuthAccessToken(await token(), config));
  mode = "success";
  const verified = await verifyOAuthAccessToken(await token(), config);
  assert.equal(verified.subject, "local-fixture-user");
  await assert.rejects(verifyOAuthAccessToken(await token({ iss: "https://wrong.example.test" }), config));
  await assert.rejects(verifyOAuthAccessToken(await token({ aud: "https://wrong.example.test/mcp" }), config));
  await assert.rejects(verifyOAuthAccessToken(await token({ exp: 1 }), config));
  assert(requests.every(request => request.authorization === undefined));
  assert(requests.every(request => ["/metadata", "/jwks"].includes(request.path)));
  console.log("OAuth relay tests passed: exact routes, issuer/JWKS pinning, no credentials, JWT validation, no redirects.");
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
