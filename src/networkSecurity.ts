/** Parse an explicit boolean environment flag and reject ambiguous values. */
export function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new Error(`${name} must be either "true" or "false". Received: ${raw}`);
}

/** Return true only for hostnames that are unambiguously loopback addresses. */
export function isLoopbackHostname(input: string): boolean {
  const hostname = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;

  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

/** Return true when a URL uses plain HTTP for a non-loopback destination. */
export function isRemotePlainHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
}

/** Preserve the exact OAuth audience, including its path and trailing slash. */
export function validateOAuthResourceUrl(value: string): string {
  const message = "AFFINE_OAUTH_RESOURCE_URL must be a canonical HTTPS URL without userinfo, query, fragment, or wildcards.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== "https:" || url.username || url.password
    || /[?#*\\\s]/.test(value) || /%2a/i.test(value) || url.href !== value) {
    throw new Error(message);
  }
  return value;
}

/** AFFiNE Cloud is served from the `affine.pro` registrable domain. */
const AFFINE_CLOUD_DOMAIN = "affine.pro";

/**
 * Return true only when the URL belongs to AFFiNE Cloud.
 *
 * Hostnames are matched as complete labels so a self-hosted deployment cannot
 * be misclassified by a substring. `https://affine.proxy.internal` and
 * `https://affine.pro.example.com` are self-hosted, while `https://app.affine.pro`
 * and `https://affine.pro` are Cloud.
 */
export function isAffineCloudUrl(input: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(input).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return hostname === AFFINE_CLOUD_DOMAIN || hostname.endsWith(`.${AFFINE_CLOUD_DOMAIN}`);
}
