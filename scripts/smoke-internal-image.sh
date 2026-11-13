#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF="${1:?Pass the local image reference}"
test "$(docker run --rm --entrypoint node "$IMAGE_REF" -p 'process.versions.node.split(".")[0]')" = 22
test "$(docker run --rm --entrypoint id "$IMAGE_REF" -u)" = 10001
CONTAINER_ID="$(docker run -d --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001 \
  --cap-drop ALL --security-opt no-new-privileges \
  -e XDG_CONFIG_HOME=/tmp/affine-mcp \
  -e AFFINE_MCP_AUTH_MODE=oauth \
  -e AFFINE_BACKEND_AUTH_MODE=oauth_token_exchange \
  -e AFFINE_MCP_PUBLIC_BASE_URL=https://resource.example.test \
  -e AFFINE_OAUTH_RESOURCE_URL=https://resource.example.test/v1/mcp/tunnel_fixture \
  -e AFFINE_OAUTH_ISSUER_URL=https://issuer.example.test \
  -e 'AFFINE_OAUTH_SCOPES=openid email profile' \
  -e AFFINE_TOOL_PROFILE=authoring "$IMAGE_REF")"
trap 'docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true' EXIT
for attempt in {1..20}; do
  if docker exec "$CONTAINER_ID" node --input-type=module -e '
    import assert from "node:assert/strict";
    const health = await fetch("http://127.0.0.1:3000/healthz").then(r => r.json());
    assert.equal(health.protected, true);
    assert.equal(health.authMode, "oauth");
    assert.equal(health.backendAuthMode, "oauth_token_exchange");
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const metadata = await fetch(`http://127.0.0.1:3000${path}`).then(r => r.json());
      assert.equal(metadata.resource, "https://resource.example.test/v1/mcp/tunnel_fixture");
    }
    const response = await fetch("http://127.0.0.1:3000/mcp", { method: "POST" });
    assert.equal(response.status, 401);
  ' >/dev/null 2>&1; then
    echo 'Internal image smoke passed: Node 22, UID 10001, read-only root, exact external resource metadata, unauthenticated MCP denied.'
    exit 0
  fi
  sleep 1
done
echo 'Internal image smoke failed.' >&2
exit 1
