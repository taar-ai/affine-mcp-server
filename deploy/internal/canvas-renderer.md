# Wiki Canvas Renderer Operations

The external tool is `wiki.render_canvas`, proxied only through the existing
TaarInternal connector. There is no additional tunnel, callback or audience.
The worker is a sidecar in the adapter pod and listens only on 127.0.0.1:3100.
It has no Service, ingress, mounted credentials, service-account token or PVC.

The adapter exchanges the original authenticated Taar bearer using the existing
per-user flow, then passes only the short-lived native Wiki bearer to the worker.
The worker fetches an authorized immutable document snapshot, launches a fresh
sandboxed Chromium process/context, and loads the same deployed frontend from
the fixed private API origin. The browser receives no credentials. Network
requests are blocked except bounded same-origin static assets fetched by Node
without credentials. The public frontend proxy denies the renderer bootstrap.

Before returning a PNG, the worker rechecks native document access and revision.
This is explicitly NOT a linearizable read of concurrent changes. Supplying
`expectedRevision` rejects stale snapshots before rendering and changed
snapshots at the final recheck. Without it, metadata identifies the rendered
snapshot and reports whether a later revision was observed.

## Runtime Requirements

- Node selectors remain `location=ahd`, `workload=gp`.
- Both GP nodes need `profiles/wiki-renderer-v2.json` under kubelet's seccomp
  directory. Installation and browser sandbox proof are tracked on
  `k8s-bootstrap/main`, commit `77b19405`, under `k3/ahd/chromium/`.
- Only the worker overrides seccomp to Localhost. Non-root UID/GID 1000,
  AppArmor RuntimeDefault, drop-ALL capabilities and no-new-privileges remain.
- Root filesystem is read-only. `/tmp` and `/dev/shm` are separate bounded,
  memory-backed emptyDirs, not shared with the adapter's credential state.
  Core dumps are disabled. No images, tokens or document bodies are logged.
- Production concurrency is one, with no unbounded queue. Busy callers retry.
  Limits include 8 MiB snapshots, 2 MiB PNGs, 4 million pixels, 64 MiB total
  frontend assets and a 25-second request deadline plus process cleanup.
- Keep replica count one: existing document-write/session coordination is
  process-local. The renderer does not claim to solve concurrent writes.

## Rollout Gates

The deployment manifest initially sets `AFFINE_CANVAS_RENDER_ENABLED=false`.
This advertises a disabled tool but prevents user calls from reaching the
worker. The worker can still be checked locally by an authorized operator.

1. Verify exact image digests and preload images before Recreate updates.
2. Deploy the prepared Wiki frontend and public bootstrap deny, retaining the
   private API route and all existing Longhorn configuration.
3. Deploy the pinned adapter/worker sidecar with rendering disabled. Check
   readiness, UID, seccomp, AppArmor, memory mounts and negative HTTP auth.
4. Run the synthetic deployed-browser check below. It uses the real deployed
   frontend and real Chromium; only document reads/identities are injected.
5. Verify a real consenting user's existing Wiki permissions through the
   common connector. Do not fabricate real-user gateway tokens or create
   production test identities. Record separately which permission-revocation
   and two-user checks are mocked versus genuinely authenticated.
6. Enable the flag, restart the adapter pod, and verify an actual image result
   through TaarInternal. Refresh the connector catalog if the new tool is not
   yet visible. Readiness/discovery alone are not connector E2E proof.

For the synthetic check, select the running adapter pod explicitly:

```sh
kubectl --context k3 -n taar-int-affine exec -i POD_NAME -c canvas-renderer \
  -- node --input-type=module < scripts/verify-deployed-canvas-renderer.mjs
```

This checks real PNG pixels on desktop/mobile, frame selection, stale revision,
mocked denial/revocation, credential-free assets and two simultaneous synthetic
identities in separate browser processes. It does not create Wiki documents or
read the audit fixture. Its result explicitly says `nativeProductionAclTest:false`.

## Known Limits

PNG only; remote embeds, attachments, images/blobs and referenced documents are
not fetched. The frontend reports fixed fidelity warnings for unsupported
content. Warnings and immutable-snapshot consistency must remain in tool output.
No source or audit document is written during rendering.

## Rollback

Disable rendering in the ConfigMap and restart the adapter. For a full adapter
rollback, restore the previous reviewed manifest (not just its MCP image), so
the worker and its memory volumes are removed as well. The pre-renderer adapter
manifest is in `eaa8528`; its image digest is
`7a18dee7144948deff1f588a1820ea31ebe2f939ae220299b81cf4d9e9355cd2`.
The prior Wiki frontend digest is
`943f330a5925d956d1c6656bfc3e3dbabf1e890019416987d4f865eecb716249`.
The new public-route deny may remain in place during a frontend rollback.
Never remove node profiles while a pod deployment still references them.
