/**
 * Server function: read the client's website once — its logo and its own words
 * about itself. Both are best effort; a failure returns null and the deck falls
 * back to the client's name and its retrieved evidence.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractClientLogo, fetchSiteText, type ClientLogo } from "./client-logo";

export type AnalyzeTargetSiteResult = {
  ok: boolean;
  logo: ClientLogo | null;
  siteText: string | null;
  error?: string;
};

export const analyzeTargetSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    // The app stores websites scheme-less (`normaliseWebsite` strips it for
    // display), so add one back before the URL check, which requires it.
    const { url } = z.object({ url: z.string().trim().min(1).max(500) }).parse(data);
    return { url: /^https?:\/\//i.test(url) ? url : `https://${url}` };
  })
  .handler(async ({ data }): Promise<AnalyzeTargetSiteResult> => {
    const log = (event: string, meta: Record<string, unknown>) => console.log(`[SITE] ${event}`, meta);
    const [logo, siteText] = await Promise.all([
      extractClientLogo(data.url, log),
      fetchSiteText(data.url, log),
    ]);
    if (!logo && !siteText) {
      return { ok: false, logo: null, siteText: null, error: "Nothing readable on that site." };
    }
    return { ok: true, logo, siteText };
  });
