/**
 * Server function: read the client's website once — its logo and its own words
 * about itself. Both are best effort; a failure returns null and the deck falls
 * back to the client's name and its retrieved evidence. The logo is returned
 * raw; the browser rasterises it before the target is stored.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractClientLogo, fetchSiteText, type RawLogo } from "@/lib/logo/server";

export type AnalyzeTargetSiteResult = {
  ok: boolean;
  logo: RawLogo | null;
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
    const log = (event: string, meta: Record<string, unknown>) =>
      console.log(`[SITE] ${event}`, meta);
    const [logo, siteText] = await Promise.all([
      extractClientLogo(data.url).catch(() => null),
      fetchSiteText(data.url).catch(() => null),
    ]);
    log("analyzed", {
      url: data.url,
      logo: logo?.url ?? null,
      source: logo?.source ?? null,
      siteText: Boolean(siteText),
    });
    if (!logo && !siteText) {
      return { ok: false, logo: null, siteText: null, error: "Nothing readable on that site." };
    }
    return { ok: true, logo, siteText };
  });
