const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackAddress(address?: string): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address.toLowerCase());
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function isLocalManagementRequest(
  url: URL,
  remoteAddress?: string,
): boolean {
  return isLoopbackHostname(url.hostname) && isLoopbackAddress(remoteAddress);
}
