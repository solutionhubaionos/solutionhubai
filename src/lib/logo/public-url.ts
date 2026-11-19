/** Addresses a document may never read: loopback, private networks and internal hosts. */
export const PRIVATE_HOSTNAME =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd]|.*\.local$|.*\.internal$)/i;

/** A public http(s) address, or null. Pure and edge-safe: no DNS, no native addon. */
export function publicUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (
      PRIVATE_HOSTNAME.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.includes(":")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
