# Internal Taar deployment (pending manifest review)

This directory stages the delegated deployment in namespace `taar-int-affine`.
The internal target is `https://affine-mcp.internal.taar.ltd/mcp`; it is not the
OAuth audience. The authoritative path is ChatGPT -> EXISTING TaarInternal
tunnel -> existing Taar MCP gateway -> this internal adapter -> AFFiNE API.
There is no new tunnel, callback or direct ChatGPT access to this adapter.
It creates a ClusterIP service on 443 with a non-root nginx TLS sidecar on 8443,
and a DNS01 Certificate using the existing `letsencrypt-cloudflare` ClusterIssuer.
It has no Ingress, NodePort, LoadBalancer, persistent volume, shared AFFiNE
account, or Kubernetes API token mount. No public A record is needed. The parent
owns the exact-host private CoreDNS override pointing to the Service ClusterIP.
Do not apply until parent review and authorization. Preparing these files does
not deploy any cluster resources.

## Required parent contracts

Verified existing resource (parent-supplied, no new tunnel):

```text
https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6aa164e03b0c81918f288517e6e55002
```

- Supply the verified exact EXISTING TaarInternal tunnel MCP resource as
  ConfigMap `affine-mcp-resource`, key `OAUTH_RESOURCE`, in `taar-int-affine`.
  The manifest requires this key for `AFFINE_OAUTH_RESOURCE_URL`; a missing map
  or key prevents the pod starting, and an empty/invalid value fails config
  validation. This repository does not create or populate that ConfigMap.
  AFFiNE's `TAAR_MCP_OAUTH_RESOURCE` references the same shared key. Use the
  identical existing resource in the gateway and AFFiNE audience policy. The
  gateway forwards the ORIGINAL authenticated bearer, owns `affine.*` tool
  proxying, discovery, attribution and bypass prevention. No callback is added.
  Do not append `/mcp` to a tunnel path such as `/v1/mcp/tunnel_ID`.
  Explicit resources require canonical HTTPS with no userinfo, query, fragment
  or wildcard. JWT `aud` must be exactly that single string: arrays, different
  tunnels, trailing-slash variants and internal/base audiences are rejected.
  The internal `AFFINE_MCP_PUBLIC_BASE_URL` still determines local routes and
  challenges. Both local `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp` advertise the external resource.
  The gateway owns how the existing tunnel serves these discovery routes and
  any external challenge URL rewriting. No public URL is enabled by this change.
- MCP pod label is `app.kubernetes.io/name=affine-mcp` in `taar-int-affine`.
  Only `taar-internal` pods labeled
  `app.kubernetes.io/name=openai-mcp-gateway` may reach TCP 8443. There is no
  laptop/VPN, public, direct ChatGPT or tunnel-workload access to this adapter.
- AFFiNE's private API is Service `affine-api:3010`, with pod label
  `app.kubernetes.io/name=affine`. Relay is Service `affine-taar-jwks:8080`, with
  pod label `app.kubernetes.io/name=affine-taar-jwks`, in the same namespace.
  The parent owns the new private API Service and ingress policy: only adapter
  pods reach application port 3010. Public Service `affine` instead targets
  the parent's nginx port 3012, which denies `/api/auth/taar/mcp` paths. This
  repository does not create or alter those application resources.
- `taaracr0-secret` exists in the namespace and is referenced for image pulls.
  Pod scheduling is pinned to `location=ahd`, `workload=gp`.
- Confirm DNS uses kube-system pods labeled `k8s-app=kube-dns`. Node-local DNS
  needs a reviewed, specific DNS destination adjustment.
- AFFiNE must implement `POST /api/auth/taar/mcp/token` with exact issuer/resource
  validation, existing-user lookup only, and native per-user tokens lasting at
  most 300 seconds. MCP uses `oauth_token_exchange` and binds requests to the
  authenticated subject. It must never receive a shared backend credential.
- `AFFINE_TOKEN_EXCHANGE_URL=http://affine-api:3010/api/auth/taar/mcp/token` is an
  absolute same-origin endpoint. It overrides the legacy path setting and
  rejects different origins, userinfo, query, fragment, wildcard and redirects.
  HTTP uses only the existing explicit `AFFINE_ALLOW_INSECURE_HTTP=true` opt-in
  for the internal AFFiNE origin. The original request bearer is forwarded;
  user identity, email and roles never come from tool arguments. Exchange
  failures have no service-account fallback and do not reflect response bodies.
- In delegated mode the adapter accepts only RS256, `token_type=access`, boolean
  `email_verified=true`, a nonempty subject and an unexpired token, plus the
  exact configured string audience and required scopes. The backend owns
  persistent `(iss, sub)` mapping to existing enabled, verified users and their
  existing permissions, with no auto-create or global shared account. Native
  token responses over 300 seconds are rejected. Sessions bind issuer+subject;
  exchange caches bind original token digest, issuer, subject and resource.
- Issuer is `https://int30.taar.ltd`, canonical JWKS is
  `https://int30.taar.ltd/.well-known/jwks.json`, and advertised scopes are
  `openid email profile`.

## Issuer relay contract

The parent-owned service `affine-taar-jwks:8080` serves GET `/jwks` and
GET `/metadata`. `/metadata` returns exactly
`https://int30.taar.ltd/.well-known/oauth-authorization-server`, unchanged,
including canonical `issuer` and `jwks_uri`. `/jwks` returns exactly
`https://int30.taar.ltd/.well-known/jwks.json`. Both routes must proxy only
these exact HTTPS issuer paths with certificate verification, no redirects,
no client Authorization header, and no general forward-proxy capability.
Block other methods and paths at the relay. This repo does not deploy the relay.

Setting `AFFINE_OAUTH_METADATA_RELAY_BASE_URL` explicitly routes verification
material through those two paths. Issuer, resource audience and asymmetric JWT
signature checks retain their canonical values. Metadata issuer mismatch and
any JWKS URI other than the issuer's `/.well-known/jwks.json` fail closed.
Relay failures do not fall back to public egress. The MCP NetworkPolicy permits
only DNS, AFFiNE TCP 3010, and relay TCP 8080; it grants no public TCP 443 access.
NetworkPolicies are additive: the parent must also check that another policy
does not grant this pod broader access, and that the CNI enforces these rules.

The configured relay base is `http://affine-taar-jwks:8080`. That exact short
origin is allowed explicitly; other short HTTP origins or ports are rejected.
The ordinary HTTPS requirement for OAuth issuer/resource URLs is unchanged.

## TLS runtime

The nginx image is pinned to the existing relay's digest
`sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236`.
MCP listens only on loopback TCP 3000; the Service targets nginx TCP 8443.
Both containers have read-only roots, dropped capabilities and bounded memory
`emptyDir` scratch space. All nginx temp paths are under `/tmp`. The TLS
Secret `affine-mcp-internal-tls` is mounted 0440, readable by nginx UID 101
through pod fsGroup 10001. Certificates are reloaded hourly after nginx config
validation. Access logging is disabled so request URLs/tokens are not logged.

## Image build

`Dockerfile` builds TypeScript from this repository with `npm ci`; it does not
install a published upstream MCP package. Builder and runtime use the same
digest-pinned Node 22 base. Runtime UID/GID is 10001.

Published AMD64 image with exact tunnel resource support (ACR build `cu27`):

```text
taaracr0.azurecr.io/taar-affine-mcp@sha256:f1bf6918ecb1f01e65911dfcc518cf0a6dd1d90df761fd8a0ddc7292587a97f6
```

Source revision: `d17632c263eca55cf56a2dc4dc12a46abc1b1b37`.
Built using the existing Azure identity; no registry token or GitHub secret was
created. The existing `taaracr0-secret` grants pull access to this repository.

```sh
export PATH=/Users/devanshjain/.nvm/versions/node/v22.19.0/bin:$PATH
npm ci
npm test
docker build --platform linux/arm64 -t taar-affine-mcp:delegated-local .
bash scripts/smoke-internal-image.sh taar-affine-mcp:delegated-local
bash scripts/smoke-internal-tls.sh taar-affine-mcp:delegated-local
```

The manual `Taar Internal Image` GitHub workflow builds both amd64 and arm64
from the selected repository ref after tests, publishes only
`taaracr0.azurecr.io/taar-affine-mcp:sha-<commit>`, and records the immutable
`taaracr0.azurecr.io/taar-affine-mcp@sha256:...` reference in its job summary.
Deploy that digest, never the mutable tag. No deployment occurs in the workflow.

Source image publication is authorized. Prefer `az acr build` under the existing
Azure identity without creating a new credential. If the GitHub workflow needs
a dedicated credential, use an
ACR scope map limited to `repositories/taar-affine-mcp/content/read` and
`repositories/taar-affine-mcp/content/write`; store its token username/password
in GitHub secrets `TAAR_AFFINE_MCP_ACR_USERNAME` and
`TAAR_AFFINE_MCP_ACR_PASSWORD` without printing values. Do not enable ACR admin
credentials. Preparing this workflow creates no registry credentials.

## Review and deploy

`deploy/internal/deployment.yaml` contains the immutable published image and
concrete internal hostnames/selectors, with a required parent-owned external
resource ConfigMap reference. It has no rendering variables. Review the manifest
before the parent authorizes applying it. Keep replicas at one with Recreate updates:
document write coordination and MCP sessions are process-local. Expect session
reinitialization during updates. The runtime has a read-only root filesystem
with a bounded ephemeral `/tmp`; no saved user credentials are provided.

After authorization, the parent can perform a server dry run, diff, apply and
rollout check against the explicitly selected internal cluster. Verify image
digest, non-root security context, endpoints, `/healthz` protection, `/readyz`,
and denied unauthorized callers. Readiness checks metadata and unauthenticated
GraphQL schema access; it does not prove a delegated exchange or user access.
Use real consenting users for permission-isolation verification: each must see
only their own existing AFFiNE access, with cross-subject session reuse denied.
Verify relay logs contain only metadata/JWKS GET requests and no tokens, and
prove public egress is denied. Roll back to the prior reviewed image digest if
rollout or delegated checks fail. Never create production test identities.

Wait for Certificate readiness and validate the real TLS chain before client
tests. The local TLS smoke uses an explicitly trusted disposable CA fixture;
it does not disable TLS verification or contact production identity endpoints.
