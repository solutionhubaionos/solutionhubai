import { supabase } from "@/integrations/supabase/client";

type Event =
  | { event_type: "file_open"; content_id: string; industry: string }
  | { event_type: "industry_view"; industry: string };

// Fire-and-forget usage logging; never blocks or breaks the UI.
export async function logActivity(e: Event) {
  try {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return;
    await supabase.from("activity_events").insert({ ...e, user_id: user.id, user_email: user.email ?? null });
  } catch {
    /* ignore */
  }
}
