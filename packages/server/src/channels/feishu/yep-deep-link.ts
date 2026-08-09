import { isIP } from "node:net";

export const FEISHU_TURN_REFERENCE_PATTERN = /^feishu-[a-f0-9]{32}$/;

export type YepDeepLinkUnavailableReason =
  | "public_origin_unconfigured"
  | "public_origin_unsafe"
  | "turn_reference_unavailable";

export type YepDeepLinkAvailability =
  | { state: "available"; url: string }
  | { state: "unavailable"; reason: YepDeepLinkUnavailableReason };

/**
 * Build an authenticated Yep session locator link from server-owned values.
 *
 * The URL never accepts a redirect target, real provider session id, project
 * path, or credential. The opaque Feishu inbox reference is resolved only by
 * Yep's authenticated locate API.
 */
export function buildYepFeishuTurnDeepLink(input: {
  publicBaseUrl?: string;
  turnReference?: string;
}): YepDeepLinkAvailability {
  const publicBaseUrl = input.publicBaseUrl?.trim();
  if (!publicBaseUrl) {
    return { state: "unavailable", reason: "public_origin_unconfigured" };
  }
  if (
    !input.turnReference ||
    !FEISHU_TURN_REFERENCE_PATTERN.test(input.turnReference)
  ) {
    return { state: "unavailable", reason: "turn_reference_unavailable" };
  }

  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return { state: "unavailable", reason: "public_origin_unsafe" };
  }
  if (!isSafePublicYepBaseUrl(url)) {
    return { state: "unavailable", reason: "public_origin_unsafe" };
  }

  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/sessions/${input.turnReference}`;
  return { state: "available", url: url.toString() };
}

function isSafePublicYepBaseUrl(url: URL): boolean {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  if (!isSafeBasePath(url.pathname)) return false;
  return isPublicHostname(url.hostname);
}

function isSafeBasePath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (
    [...decoded].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || character === "\\";
    })
  ) {
    return false;
  }
  if (!/^\/[A-Za-z0-9._~%/-]*$/.test(pathname)) return false;
  return !decoded
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function isPublicHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) return false;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPublicIpv4(hostname);
  if (ipVersion === 6) return isPublicIpv6(hostname);

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal") ||
    !hostname.includes(".")
  ) {
    return false;
  }
  return /^[a-z0-9.-]+$/.test(hostname);
}

function isPublicIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224)
    return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;

  // IANA documentation/benchmark ranges are not usable public origins.
  if (first === 192 && second === 0 && (third === 0 || third === 2))
    return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  if (normalized.startsWith("::ffff:")) {
    const ipv4 = normalized.slice("::ffff:".length);
    return isIP(ipv4) === 4 && isPublicIpv4(ipv4);
  }
  return true;
}
