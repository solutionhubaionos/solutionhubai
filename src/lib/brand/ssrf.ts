/**
 * SSRF guard for user-supplied URLs. This app fetches arbitrary addresses typed
 * by a salesperson, so every hop is checked: scheme, literal IP, and DNS answer.
 * Redirects are followed manually by the caller, one hop at a time, through this
 * same guard.
 *
 * The checks are pure except `assertPublicDns`, which takes its resolver as an
 * argument so the rules can be tested without a network.
 */
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

type Range = [string, number];

const V4_RANGES: Range[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inV4Range(address: string, range: Range): boolean {
  const value = v4ToInt(address);
  const network = v4ToInt(range[0]);
  if (value === null || network === null) return false;
  const mask = range[1] === 0 ? 0 : (0xffffffff << (32 - range[1])) >>> 0;
  return (value & mask) === (network & mask);
}

/** Expands a compressed IPv6 address to eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (!value.includes(":")) return null;
  const [head = "", tail = ""] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (value.split("::").length > 2) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: value.includes("::") ? fill : 0 }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    return Number.parseInt(group, 16);
  });
  return numbers.includes(null as unknown as number) ? null : (numbers as number[]);
}

function isForbiddenIpv6(address: string): boolean {
  // An IPv4-mapped address is only as safe as the IPv4 address inside it.
  const mapped = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [first = 0, second = 0] = groups;
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  return false;
}

/** True for loopback, private, link-local, metadata and otherwise unroutable IPs. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return V4_RANGES.some((range) => inV4Range(address, range));
  if (family === 6) return isForbiddenIpv6(address);
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export type DnsResolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[] | { address: string; family: number }>;

/**
 * Validates an already-parsed URL without touching the network: http(s) only,
 * a host we are willing to resolve, and an IP literal that is public.
 */
export function assertAllowedUrl(input: URL | string): URL {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https addresses can be read.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Addresses with credentials are not allowed.");
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("That address has no host.");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("That address is not reachable from here.");
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new UnsafeUrlError("Private and internal addresses are not allowed.");
  }
  return url;
}

/**
 * Resolves the host and rejects the URL when *any* answer is private. Checking
 * every answer (not just the first) closes the DNS-rebinding gap where a name
 * returns one public and one internal address.
 */
export async function assertPublicDns(url: URL, resolve?: DnsResolver): Promise<URL> {
  const allowed = assertAllowedUrl(url);
  const host = allowed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return allowed;

  // `node:dns` is imported lazily so a non-Node target can still load this
  // module; a caller that supplies its own resolver never touches it.
  const resolver =
    resolve ??
    (async (hostname: string) =>
      (await import("node:dns/promises")).lookup(hostname, { all: true, verbatim: true }));

  let answers: { address: string; family: number }[];
  try {
    const result = await resolver(host);
    answers = Array.isArray(result) ? result : [result];
  } catch {
    throw new UnsafeUrlError("That address could not be resolved.");
  }
  if (answers.length === 0) throw new UnsafeUrlError("That address could not be resolved.");
  for (const answer of answers) {
    if (isPrivateAddress(answer.address)) {
      throw new UnsafeUrlError("That address resolves to a private network.");
    }
  }
  return allowed;
}
