# Internal Taar deployment (pending resource URL approval)

This directory stages the delegated deployment in namespace `taar-int-affine`.
It creates only a ClusterIP service. It has no ingress, NodePort, LoadBalancer,
shared AFFiNE account, credential secret, or Kubernetes API token mount.
Do not apply the template until the parent reviews its rendered values and
authorizes the cluster change. No cluster resources have been changed by preparing it.

## Required parent contracts

- Supply the exact MCP resource URL and corresponding base URL. The current
  validator requires HTTPS outside loopback. The template therefore requires a
  private TLS gateway and valid certificate if HTTPS is chosen. It does not
  provision that gateway or choose a domain. Kubernetes DNS over HTTP remains
  blocked until a separately reviewed, explicit hostname-pinned cluster mode
  is implemented; do not disable TLS verification or the default HTTPS check.
- Confirm AFFiNE service name and pod `app.kubernetes.io/name` label, relay pod
  label, and the allowed client/gateway namespace and pod label. The label keys
  in the template must be adapted if the existing workloads use other keys.
- Confirm DNS uses kube-system pods labeled `k8s-app=kube-dns`. Node-local DNS
  needs a reviewed, specific DNS destination adjustment.
- AFFiNE must implement `POST /api/auth/taar/mcp/token` with exact issuer/resource
  validation, existing-user lookup only, and native per-user tokens lasting at
  most 300 seconds. MCP uses `oauth_token_exchange` and binds requests to the
  authenticated subject. It must never receive a shared backend credential.
- Issuer is `https://int30.taar.ltd`, canonical JWKS is
  `https://int30.taar.ltd/.well-known/jwks.json`, and advertised scopes are
  `openid email profile`.

## Issuer relay contract

The parent-owned service `affine-taar-jwks:8080` must serve GET `/jwks` **and**
GET `/metadata`. `/metadata` must return the issuer's authorization-server or
OpenID discovery JSON unchanged, including canonical `issuer` and `jwks_uri`.
The existing `/jwks` route alone is insufficient. Both routes must proxy only
their exact HTTPS issuer paths with certificate verification, no redirects,
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

## Image build

`Dockerfile` builds TypeScript from this repository with `npm ci`; it does not
install a published upstream MCP package. Builder and runtime use the same
digest-pinned Node 22 base. Runtime UID/GID is 10001.

```sh
export PATH=/Users/devanshjain/.nvm/versions/node/v22.19.0/bin:$PATH
npm ci
npm test
docker build --platform linux/arm64 -t taar-affine-mcp:delegated-local .
bash scripts/smoke-internal-image.sh taar-affine-mcp:delegated-local
```

The manual `Taar Internal Image` GitHub workflow builds both amd64 and arm64
from the selected repository ref after tests, publishes only
`taaracr0.azurecr.io/taar-affine-mcp:sha-<commit>`, and records the immutable
`taaracr0.azurecr.io/taar-affine-mcp@sha256:...` reference in its job summary.
Deploy that digest, never the mutable tag. No deployment occurs in the workflow.

Registry credential creation is pending parent approval. If approved, use an
ACR scope map limited to `repositories/taar-affine-mcp/content/read` and
`repositories/taar-affine-mcp/content/write`; store its token username/password
in GitHub secrets `TAAR_AFFINE_MCP_ACR_USERNAME` and
`TAAR_AFFINE_MCP_ACR_PASSWORD` without printing values. Do not enable ACR admin
credentials. Cluster pull permission must already cover this repository or be
reviewed separately. Preparing this workflow creates no registry credentials.

## Render and review

Set the following environment variables from confirmed parent values:
`MCP_PUBLIC_BASE_URL`, `MCP_IMAGE_DIGEST` (including `sha256:`),
`AFFINE_SERVICE_NAME`, `AFFINE_POD_LABEL`, `ISSUER_RELAY_POD_LABEL`,
`MCP_CLIENT_NAMESPACE`, and `MCP_CLIENT_POD_LABEL`.

```sh
envsubst '${MCP_PUBLIC_BASE_URL} ${MCP_IMAGE_DIGEST} ${AFFINE_SERVICE_NAME} ${AFFINE_POD_LABEL} ${ISSUER_RELAY_POD_LABEL} ${MCP_CLIENT_NAMESPACE} ${MCP_CLIENT_POD_LABEL}' \
  < deploy/internal/deployment.yaml.template > /tmp/affine-mcp-reviewed.yaml
```

Review the rendered manifest and confirm all variables resolved before the
parent authorizes applying it. Keep replicas at one with Recreate updates:
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
