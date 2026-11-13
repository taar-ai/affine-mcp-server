import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { fetch } from "undici";

import type { AuthSnapshot } from "./authSession.js";
import { ToolFailure } from "./util/mcp.js";
import { fetchResponseBody } from "./util/httpResponse.js";

type CachedToken = {
  expiresAt: number;
  snapshot: AuthSnapshot;
};

type PendingToken = {
  expiresAt: number;
  pending: Promise<CachedToken>;
};

type TokenExchangeResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

export type DelegatedAuthOptions = {
  baseUrl: string;
  cacheMaxEntries?: number;
  exchangePath: string;
  timeoutMs: number;
};

const delegatedAuthContext = new AsyncLocalStorage<AuthInfo>();
const CACHE_EXPIRY_SKEW_MS = 30_000;

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function principalSubject(authInfo: AuthInfo): string | null {
  return typeof authInfo.extra?.subject === "string" && authInfo.extra.subject.trim()
    ? authInfo.extra.subject
    : null;
}

function sanitizedErrorBody(body: string): string {
  const compact = body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

export function runWithDelegatedAuth<T>(authInfo: AuthInfo | undefined, operation: () => T): T {
  if (!authInfo?.token || !principalSubject(authInfo)) {
    throw new ToolFailure(
      "The authenticated MCP request does not include a usable user identity.",
      "auth_required",
    );
  }
  return delegatedAuthContext.run(authInfo, operation);
}

/**
 * Exchanges the current MCP caller's OAuth token for a short-lived AFFiNE API
 * token. AsyncLocalStorage keeps concurrent MCP callers isolated while the
 * existing GraphQL and WebSocket clients continue to share one implementation.
 */
export class DelegatedAffineAuth {
  private readonly cache = new Map<string, CachedToken | PendingToken>();
  private readonly cacheMaxEntries: number;
  private readonly exchangeUrl: URL;

  constructor(private readonly options: DelegatedAuthOptions) {
    this.cacheMaxEntries = options.cacheMaxEntries ?? 128;
    this.exchangeUrl = new URL(options.exchangePath, `${options.baseUrl.replace(/\/$/, "")}/`);
    if (this.exchangeUrl.origin !== new URL(options.baseUrl).origin) {
      throw new Error("AFFINE_TOKEN_EXCHANGE_PATH must resolve to the configured AFFINE_BASE_URL origin.");
    }
  }

  async ready(): Promise<AuthSnapshot> {
    const authInfo = delegatedAuthContext.getStore();
    if (!authInfo?.token || !principalSubject(authInfo)) {
      throw new ToolFailure(
        "No authenticated MCP caller is bound to this AFFiNE operation.",
        "auth_required",
      );
    }

    const key = tokenDigest(authInfo.token);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      if ("pending" in cached) {
        if (cached.expiresAt > now) return (await cached.pending).snapshot;
      } else if (cached.expiresAt > now) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.snapshot;
      }
      this.cache.delete(key);
    }

    const pending = this.exchange(authInfo).catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { expiresAt: now + this.options.timeoutMs, pending });
    this.trimCache();
    const exchanged = await pending;
    this.cache.set(key, exchanged);
    return exchanged.snapshot;
  }

  private async exchange(authInfo: AuthInfo): Promise<CachedToken> {
    const { response, body } = await fetchResponseBody(
      signal => fetch(this.exchangeUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${authInfo.token}`,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ audience: "affine-api" }),
        signal,
      }),
      { label: "AFFiNE delegated token exchange", timeoutMs: this.options.timeoutMs },
    );

    if (!response.ok) {
      const detail = sanitizedErrorBody(body);
      const message = `AFFiNE delegated token exchange returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
      if (response.status === 401) throw new ToolFailure(message, "auth_required");
      if (response.status === 403) throw new ToolFailure(message, "access_denied");
      throw new ToolFailure(message, response.status >= 500 ? "upstream_unavailable" : "auth_required");
    }

    let payload: TokenExchangeResponse;
    try {
      payload = JSON.parse(body) as TokenExchangeResponse;
    } catch {
      throw new ToolFailure("AFFiNE delegated token exchange returned invalid JSON.", "upstream_unavailable");
    }

    if (payload.token_type !== "Bearer" || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new ToolFailure("AFFiNE delegated token exchange returned an invalid bearer token response.", "upstream_unavailable");
    }
    if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
      throw new ToolFailure("AFFiNE delegated token exchange returned an invalid expires_in value.", "upstream_unavailable");
    }

    const upstreamExpiry = typeof authInfo.expiresAt === "number"
      ? authInfo.expiresAt * 1000
      : Number.POSITIVE_INFINITY;
    const exchangedExpiry = Date.now() + payload.expires_in * 1000;
    const expiresAt = Math.max(Date.now(), Math.min(upstreamExpiry, exchangedExpiry) - CACHE_EXPIRY_SKEW_MS);
    return {
      expiresAt,
      snapshot: { kind: "bearer", token: payload.access_token },
    };
  }

  private trimCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}
