/**
 * Server function: detect the client's logo from a website URL. Best effort —
 * a failure returns { ok: false } and the deck falls back to the client's name.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractClientLogo } from "./client-logo";

export type ExtractLogoResult =
  | { ok: true; logo: NonNullable<Awaited<ReturnType<typeof extractClientLogo>>> }
  | { ok: false; error: string };

export const extractTargetLogo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ url: z.string().trim().url().max(500) }).parse(data))
  .handler(async ({ data }): Promise<ExtractLogoResult> => {
    const logo = await extractClientLogo(data.url, (event, meta) =>
      console.log(`[LOGO] ${event}`, meta),
    );
    return logo ? { ok: true, logo } : { ok: false, error: "No usable logo found on that site." };
  });
