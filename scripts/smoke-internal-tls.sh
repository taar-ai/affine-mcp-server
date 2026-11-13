#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF="${1:?Pass the local MCP image reference}"
NGINX_IMAGE=nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
FIXTURE_DIR="$(mktemp -d)"
MCP_ID=
TLS_ID=
cleanup() {
  if [ -n "$TLS_ID" ]; then docker rm -f "$TLS_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$MCP_ID" ]; then docker rm -f "$MCP_ID" >/dev/null 2>&1 || true; fi
  rm -rf "$FIXTURE_DIR"
}
trap cleanup EXIT

# A local CA fixture is explicitly trusted by curl; TLS verification stays enabled.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Local-MCP-Fixture-CA \
  -keyout "$FIXTURE_DIR/ca.key" -out "$FIXTURE_DIR/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=affine-mcp.internal.taar.ltd \
  -keyout "$FIXTURE_DIR/tls.key" -out "$FIXTURE_DIR/tls.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$FIXTURE_DIR/tls.csr" \
  -CA "$FIXTURE_DIR/ca.crt" -CAkey "$FIXTURE_DIR/ca.key" -CAcreateserial \
  -extfile <(echo 'subjectAltName=DNS:affine-mcp.internal.taar.ltd') \
  -out "$FIXTURE_DIR/tls.crt" >/dev/null 2>&1
ruby -ryaml -e 'd = YAML.load_stream(File.read(ARGV[0])).find { |x| x.dig("metadata", "name") == "affine-mcp-tls" }; File.write(ARGV[1], d.fetch("data").fetch("nginx.conf"))' \
  deploy/internal/deployment.yaml "$FIXTURE_DIR/nginx.conf"
# Match the cert-manager Secret permission model for the non-root TLS process.
docker run --rm --user 0 --entrypoint /bin/sh -v "$FIXTURE_DIR:/fixture" "$NGINX_IMAGE" \
  -ec 'chown 0:10001 /fixture/tls.key /fixture/tls.crt; chmod 0440 /fixture/tls.key /fixture/tls.crt; chmod 0755 /fixture'
MCP_ID="$(docker run -d --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::8443 --tmpfs /tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001 \
  -e XDG_CONFIG_HOME=/tmp/affine-mcp -e AFFINE_MCP_HTTP_HOST=127.0.0.1 \
  -e AFFINE_MCP_AUTH_MODE=oauth -e AFFINE_BACKEND_AUTH_MODE=oauth_token_exchange \
  -e AFFINE_MCP_PUBLIC_BASE_URL=https://affine-mcp.internal.taar.ltd \
  -e AFFINE_OAUTH_ISSUER_URL=https://issuer.example.test \
  -e AFFINE_TOOL_PROFILE=authoring "$IMAGE_REF")"
TLS_ID="$(docker run -d --network "container:$MCP_ID" --user 101:101 --group-add 10001 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=8m,uid=101,gid=101 \
  -v "$FIXTURE_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$FIXTURE_DIR/tls.crt:/etc/nginx/tls/tls.crt:ro" \
  -v "$FIXTURE_DIR/tls.key:/etc/nginx/tls/tls.key:ro" \
  --entrypoint nginx "$NGINX_IMAGE" -g 'daemon off;')"
HOST_PORT="$(docker port "$MCP_ID" 8443/tcp)"
HOST_PORT="${HOST_PORT##*:}"
for attempt in {1..30}; do
  if curl --silent --fail --noproxy '*' --cacert "$FIXTURE_DIR/ca.crt" \
    --resolve "affine-mcp.internal.taar.ltd:$HOST_PORT:127.0.0.1" \
    "https://affine-mcp.internal.taar.ltd:$HOST_PORT/healthz" > "$FIXTURE_DIR/health.json"; then
    node --input-type=module -e '
      import assert from "node:assert/strict";
      import fs from "node:fs";
      const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      assert.equal(health.protected, true);
      assert.equal(health.backendAuthMode, "oauth_token_exchange");
    ' "$FIXTURE_DIR/health.json"
    STATUS="$(curl --silent --noproxy '*' --cacert "$FIXTURE_DIR/ca.crt" \
      --resolve "affine-mcp.internal.taar.ltd:$HOST_PORT:127.0.0.1" \
      -X POST -o /dev/null -w '%{http_code}' "https://affine-mcp.internal.taar.ltd:$HOST_PORT/mcp")"
    test "$STATUS" = 401
    docker exec "$TLS_ID" nginx -t -q
    echo 'TLS frontend smoke passed: pinned nginx, non-root/read-only, group-readable key, verified TLS, protected MCP.'
    exit 0
  fi
  sleep 1
done
echo 'TLS frontend smoke failed.' >&2
docker logs "$TLS_ID"
exit 1
