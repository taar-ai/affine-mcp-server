#!/usr/bin/env bash
set -euo pipefail
image="${1:?renderer image required}"
docker run --rm --network none --read-only --user 1001:1001 \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,uid=1001,gid=1001 \
  --entrypoint node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import { canvasRenderServer } from "./dist/canvasRenderServer.js";
import { CanvasRenderer } from "./dist/canvasRenderer.js";
assert.equal(process.getuid(), 1001);
const server = canvasRenderServer(new CanvasRenderer({backendOrigin:"http://unreachable.invalid"}));
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin+"/healthz")).status,200);
  const result = await fetch(origin+"/render",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:"test",docId:"test"})});
  assert.equal(result.status,401);
  assert.equal(result.headers.get("cache-control"),"no-store");
  assert.equal((await result.json()).error.code,"AUTH_REQUIRED");
  console.log("PASS: renderer image non-root listener and unauthenticated fail-closed boundary");
} finally {await new Promise(resolve=>server.close(resolve));}
'
