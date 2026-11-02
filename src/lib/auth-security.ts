const TRUSTED_ORIGINS = new Set([
  "https://solutionhub.aionos.ai",
  "https://solutionhubai.lovable.app",
  "https://id-preview--431c2fcf-8c31-4cab-b77a-4a46bc067368.lovable.app",
]);

export function passwordRedirect(origin: string) {
  const url = new URL(origin);
  const local = url.protocol === "http:" && url.hostname === "localhost" && url.port === "8080";
  if ((!TRUSTED_ORIGINS.has(url.origin) && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Untrusted password reset destination");
  }
  return `${url.origin}/reset-password`;
}