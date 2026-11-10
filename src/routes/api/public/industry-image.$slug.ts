import { createFileRoute } from "@tanstack/react-router";

// Serves AI-generated industry cover images (public, non-sensitive).
export const Route = createFileRoute("/api/public/industry-image/$slug")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!/^[a-z0-9-]{1,60}$/.test(params.slug))
          return new Response("Not found", { status: 404 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.storage
          .from("industry-images")
          .download(`${params.slug}.jpg`);
        if (error || !data) return new Response("Not found", { status: 404 });
        return new Response(data, {
          headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
        });
      },
    },
  },
});
