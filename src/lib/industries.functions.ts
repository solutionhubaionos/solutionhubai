import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { slugify } from "./industries";

export const createIndustry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        name: z.string().trim().min(2).max(50),
        tagline: z.string().trim().max(80).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const slug = slugify(data.name);
    if (!slug) return { ok: false as const, error: "Please enter a valid name." };

    const { error } = await context.supabase.from("industries").insert({
      slug,
      name: data.name,
      tagline: data.tagline || null,
      created_by: context.userId,
    });
    if (error) {
      return {
        ok: false as const,
        error:
          error.code === "23505" ? "That industry already exists." : "You can't add industries.",
      };
    }

    // Generate a themed cover image; the industry stays usable if this fails.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: permitted, error: quotaError } = await supabaseAdmin.rpc(
        "consume_request_quota",
        {
          _kind: "industry-image",
          _subject: context.userId,
          _network: "",
        },
      );
      if (quotaError || !permitted) return { ok: true as const, slug, imageFailed: true };
      const { generateImage } = await import("@lovable.dev/ai-gateway");
      const res = await generateImage({
        model: "openai/gpt-image-2.5-sunburst",
        prompt: `Cinematic wide photograph representing the ${data.name} industry${data.tagline ? ` (${data.tagline})` : ""}, realistic modern scene, teal and amber color grading, premium enterprise feel, no text, no logos`,
        size: "1536x1024",
        quality: "medium",
        output_format: "jpeg",
      });
      const b64 = res.data?.[0]?.b64_json;
      if (b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const up = await supabaseAdmin.storage
          .from("industry-images")
          .upload(`${slug}.jpg`, bytes, { contentType: "image/jpeg", upsert: true });
        if (!up.error) {
          await supabaseAdmin
            .from("industries")
            .update({ image_url: `/api/public/industry-image/${slug}?v=${Date.now()}` })
            .eq("slug", slug);
        } else console.error("upload failed", up.error.message);
      }
    } catch (e) {
      console.error("image generation failed", e);
      return { ok: true as const, slug, imageFailed: true };
    }
    return { ok: true as const, slug, imageFailed: false };
  });
