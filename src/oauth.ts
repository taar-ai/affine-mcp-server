import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { fetchResponseBody } from "./util/httpResponse.js";

export type OAuthConfig = {
  publicBaseUrl: string;
  issuerUrl: string;
  scopes: string[];
  clockSkewSeconds: number;
  metadataRelayBaseUrl?: string;
};

export type OAuthAccessTokenInfo = {
  clientId: string | null;
  expiresAt: number;
  scopes: string[];
  subject: string | null;
};

type AuthorizationServerMetadata = {
  issuer: string;
  jwks_uri?: string;
};

const ALLOWED_JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

const metadataCache = new Map<string, Promise<AuthorizationServerMetadata>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const OAUTH_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * The SDK reads `response.json()` after its fetch function resolves. Buffer the
 * body here so the same abortable timeout covers headers and full body reads.
 */
async function fetchOAuthMetadata(input: string | URL, init?: RequestInit): Promise<Response> {
  const { response, body } = await fetchResponseBody(
    signal => fetch(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
    { label: "OAuth metadata discovery", timeoutMs: OAUTH_DISCOVERY_TIMEOUT_MS },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function getOAuthResourceUrl(publicBaseUrl: string): string {
  const normalized = publicBaseUrl.replace(/\/$/, "");
  return normalized.endsWith("/mcp") ? normalized : `${normalized}/mcp`;
}

export function getOAuthProtectedResourceMetadataUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
}

export function getOAuthProtectedResourceMetadataPaths(publicBaseUrl: string): string[] {
  const primaryPath = new URL(getOAuthProtectedResourceMetadataUrl(publicBaseUrl)).pathname;
  const resourcePath = new URL(getOAuthResourceUrl(publicBaseUrl)).pathname;
  const aliasPath = `/.well-known/oauth-protected-resource${resourcePath === "/" ? "" : resourcePath}`;
  return [...new Set([primaryPath, aliasPath])];
}

export function buildOAuthProtectedResourceMetadata(config: OAuthConfig) {
  return {
    resource: getOAuthResourceUrl(config.publicBaseUrl),
    authorization_servers: [config.issuerUrl],
    scopes_supported: config.scopes,
  };
}

export function validateOAuthConfig(config: OAuthConfig, opts: { allowAnyOrigin: boolean; httpAuthToken?: string }) {
  if (opts.allowAnyOrigin) {
    throw new Error("AFFINE_MCP_HTTP_ALLOW_ALL_ORIGINS=true is not allowed when AFFINE_MCP_AUTH_MODE=oauth.");
  }
  if (opts.httpAuthToken) {
    throw new Error("AFFINE_MCP_HTTP_TOKEN is not allowed when AFFINE_MCP_AUTH_MODE=oauth.");
  }

  const publicUrl = new URL(config.publicBaseUrl);
  const issuerUrl = new URL(config.issuerUrl);

  if (publicUrl.protocol !== "https:" && !isLoopbackHostname(publicUrl.hostname)) {
    throw new Error("AFFINE_MCP_PUBLIC_BASE_URL must use HTTPS for non-local OAuth deployments.");
  }
  if (issuerUrl.protocol !== "https:" && !isLoopbackHostname(issuerUrl.hostname)) {
    throw new Error("AFFINE_OAUTH_ISSUER_URL must use HTTPS for non-local OAuth deployments.");
  }
  if (config.metadataRelayBaseUrl) validateMetadataRelayUrl(config.metadataRelayBaseUrl);
}

function validateMetadataRelayUrl(value: string): URL {
  const url = new URL(value);
  const privateHttp = url.protocol === "http:"
    && (url.hostname.endsWith(".svc.cluster.local") || isLoopbackHostname(url.hostname));
  if ((url.protocol !== "https:" && !privateHttp)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("AFFINE_OAUTH_METADATA_RELAY_BASE_URL requires an HTTPS origin or an explicit cluster-DNS HTTP origin.");
  }
  return url;
}

function buildAudienceList(config: OAuthConfig): string[] {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const resourceUrl = getOAuthResourceUrl(config.publicBaseUrl);
  return [...new Set([publicBaseUrl, resourceUrl])];
}

function getScopesFromPayload(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const scope of payload.scope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean)) {
      scopes.add(scope);
    }
  }
  const scp = payload.scp;
  if (typeof scp === "string") {
    for (const scope of scp.split(/\s+/).map((entry) => entry.trim()).filter(Boolean)) {
      scopes.add(scope);
    }
  } else if (Array.isArray(scp)) {
    for (const scope of scp) {
      if (typeof scope === "string" && scope.trim()) {
        scopes.add(scope.trim());
      }
    }
  }
  return [...scopes];
}

async function loadAuthorizationServerMetadata(config: OAuthConfig): Promise<AuthorizationServerMetadata> {
  const { issuerUrl, metadataRelayBaseUrl } = config;
  const cacheKey = JSON.stringify([issuerUrl, metadataRelayBaseUrl]);
  let pending = metadataCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      let discovered;
      if (metadataRelayBaseUrl) {
        const relay = validateMetadataRelayUrl(metadataRelayBaseUrl);
        const response = await fetchOAuthMetadata(new URL("/metadata", relay));
        if (!response.ok) throw new Error(`OAuth metadata relay returned HTTP ${response.status}`);
        discovered = await response.json();
      } else {
        discovered = await discoverAuthorizationServerMetadata(new URL(issuerUrl), {
          fetchFn: fetchOAuthMetadata,
        });
      }
      if (!discovered?.issuer || typeof discovered.issuer !== "string") {
        throw new Error(`Could not discover authorization server metadata from ${issuerUrl}`);
      }
      if (!("jwks_uri" in discovered) || typeof discovered.jwks_uri !== "string" || !discovered.jwks_uri) {
        throw new Error(`Authorization server metadata from ${issuerUrl} did not provide jwks_uri`);
      }
      if (discovered.issuer !== issuerUrl) throw new Error("OAuth metadata issuer does not match configured issuer");
      if (metadataRelayBaseUrl && discovered.jwks_uri !== `${issuerUrl.replace(/\/$/, "")}/.well-known/jwks.json`) {
        throw new Error("OAuth metadata relay jwks_uri does not match the pinned issuer JWKS route");
      }
      return {
        issuer: discovered.issuer,
        jwks_uri: discovered.jwks_uri,
      };
    })().catch((error) => {
      // Only evict this generation. A future retry must not remove a newer
      // in-flight entry if cache ownership changes between attempts.
      if (metadataCache.get(cacheKey) === pending) metadataCache.delete(cacheKey);
      throw error;
    });
    metadataCache.set(cacheKey, pending);
  }
  return pending;
}

export async function probeOAuthReadiness(config: OAuthConfig): Promise<{ issuer: string; jwksUri: string }> {
  const metadata = await loadAuthorizationServerMetadata(config);
  if (!metadata.jwks_uri) {
    throw new Error("Authorization server metadata is missing jwks_uri");
  }
  return {
    issuer: metadata.issuer,
    jwksUri: metadata.jwks_uri,
  };
}

function getJwks(metadata: AuthorizationServerMetadata, config: OAuthConfig) {
  if (!metadata.jwks_uri) {
    throw new Error("Authorization server metadata is missing jwks_uri");
  }
  const cacheKey = JSON.stringify([metadata.jwks_uri, config.metadataRelayBaseUrl]);
  let jwks = jwksCache.get(cacheKey);
  if (!jwks) {
    const relay = config.metadataRelayBaseUrl ? validateMetadataRelayUrl(config.metadataRelayBaseUrl) : undefined;
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), relay ? {
      // Only public verification material crosses the relay; never forward caller headers.
      [customFetch]: (_url, init) => fetchOAuthMetadata(new URL("/jwks", relay), { signal: init?.signal }),
    } : undefined);
    jwksCache.set(cacheKey, jwks);
  }
  return jwks;
}

export async function verifyOAuthAccessToken(token: string, config: OAuthConfig): Promise<OAuthAccessTokenInfo> {
  const metadata = await loadAuthorizationServerMetadata(config);
  const { payload } = await jwtVerify(token, getJwks(metadata, config), {
    issuer: metadata.issuer,
    audience: buildAudienceList(config),
    algorithms: [...ALLOWED_JWT_ALGORITHMS],
    clockTolerance: config.clockSkewSeconds,
  });

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Token does not include a valid exp claim");
  }

  const scopes = getScopesFromPayload(payload);
  return {
    clientId:
      typeof payload.client_id === "string"
        ? payload.client_id
        : typeof payload.azp === "string"
          ? payload.azp
          : null,
    expiresAt: payload.exp,
    scopes,
    subject: typeof payload.sub === "string" ? payload.sub : null,
  };
}
