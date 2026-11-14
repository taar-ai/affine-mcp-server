# Wiki Canvas Renderer Rollout: 2026-11-14

## Deployed State

Context `k3`, namespace `taar-int-affine`, AHD GP nodes. Rendering enabled by
activation commit `0b91a03`; deployment rollout completed, all three adapter
containers ready with zero restarts at verification. Images are digest pinned:

| Component | Image digest (registry `taaracr0.azurecr.io`) |
| --- | --- |
| `taar-affine` | `sha256:94fdc0559f7f068880441bf8e2a26e0c1923ce4e2e9498a518bbecb7518ce1e4` |
| `taar-affine-mcp` adapter | `sha256:1b9820e6078eb4234ce55710dc4fbd4299c1b1b5f6d512561bd45c08b95e84ea` |
| `taar-affine-mcp` renderer | `sha256:7910c891fa5c609db03cc0e0491dde2b7e8ea244c327edbf119cdc27abca29ed` |

Frontend runtime source: `60dae60123e86c77e6b5c049f6d95faf9dad3394`.
Adapter/renderer runtime source: `2a936e1f78dfa501a5501a239fd8e7bc1614ceaa`.
Native AMD64 adapter and renderer publication used existing ACR builds `cu2d`
and `cu2e`; these were not GitHub Actions image builds.

The node sandbox profile remains the scoped change on `k8s-bootstrap/main`
at `77b1940543e6a4eae91fdaa471941947215038b4`. No privileged containers,
disabled Chromium sandbox, global seccomp changes, storage changes, new tunnel,
new OAuth callback, DNS changes or additional service exposure were introduced.

## Verification

- MCP `npm test`: metadata checks and 63 fast suites passed, including nine
  renderer suites covering limits, cancellation, stale revision, reauthorization,
  isolation, credential-free assets, MCP image envelope and log redaction.
- Real deployed Chromium and deployed frontend acceptance passed via
  `scripts/verify-deployed-canvas-renderer.mjs`: 640x480 PNG with 21,025 green
  fixture pixels; 390x640 mobile PNG; frame selection; invalid frame rejection;
  stale revision; mocked denial/revocation; concurrent synthetic identity
  isolation; static asset fetching without credentials.
- That browser acceptance injected in-memory document reads and identities.
  It did not prove production two-user ACLs or use production test accounts.
- Separate native REST ACL tests used disposable CI users and the real native
  auth guard, access token service, database and snapshot endpoint. Own snapshot
  reads succeeded; cross-user reads were denied; session revocation returned
  401; document grant removal returned 403 with the same otherwise-valid token.
  All 17 delegated auth tests passed in
  https://github.com/taar-ai/taar-affine/actions/runs/43563581665
  at test-only source `75d2922c7f923444c81707f50eb02a9d0f68e5a5`.
- Frontend source CI passed in
  https://github.com/taar-ai/taar-affine/actions/runs/43557711120.
- Private renderer bootstrap returned 200 with frontend version `60dae6012`;
  public proxy returned 404/no-store. Worker missing/invalid bearer requests
  returned 401/no-store. Worker logs were empty at post-activation verification.
- Live authenticated TaarInternal capability discovery includes `render_canvas`
  in the effective enabled tool set. Existing authenticated document reads
  continue to work. User confirmed the refreshed connector shows the new tool.
- Audit canvas `LlZHy6aE3L` in workspace
  `06964124-26ee-4408-baea-5e120c516263` remained at 34 blocks and revision
  `0df392ce28cb0e6193615ce5d9251f5d8b6270b0b7cd9f99d7312ac0d6be6160`.
  No audit fixture was written.

## Remaining Connector Gate

An actual authenticated `wiki.render_canvas` PNG through ChatGPT has NOT yet
been verified. This agent chat still exposes the pre-refresh callable tool
catalog (without `render_canvas`), even though live backend discovery and the
user's refreshed catalog show it. Do not treat readiness, discovery, synthetic
browser tests or successful document reads as this final E2E result.

In the refreshed connector chat, read the audit canvas revision and call:

```json
{
  "workspaceId": "06964124-26ee-4408-baea-5e120c516263",
  "docId": "LlZHy6aE3L",
  "width": 1600,
  "height": 1000,
  "scale": 1,
  "expectedRevision": "<revision returned by read_doc>"
}
```

Inspect the returned PNG, metadata and fidelity warnings. Then read the document
again to confirm its revision is unchanged. Do not edit the fixture. Record the
actual result before describing connector rendering as end-to-end verified.

PNG only: remote embeds, blobs/images, attachments and referenced documents are
not fetched. Consistency is an immutable snapshot, not a linearizable read.
See `canvas-renderer.md` for limits, staged upgrades and rollback.
