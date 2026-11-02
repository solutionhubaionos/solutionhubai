export const ALLOWED_DOMAINS = [
  "aionos.ai",
  "whilter.ai",
  "inetum.com",
  "cloudanalogy.com",
  "perpetuuitiaionos.com",
] as const;

export function isAllowedEmail(email: string): boolean {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[0]) return false;
  return (ALLOWED_DOMAINS as readonly string[]).includes(parts[1] ?? "");
}
