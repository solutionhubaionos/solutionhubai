import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isAllowedEmail } from "./domains";
import { passwordRedirect } from "./auth-security";

// First-time access and forgot-password share one flow: ensure the account
// exists for an allowed domain, then email a set-password link.
export const requestPasswordLink = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ email: z.string().email().max(255), origin: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    const redirectTo = passwordRedirect(data.origin);
    const email = data.email.trim().toLowerCase();
    if (!isAllowedEmail(email)) {
      return { ok: false as const, error: "This email domain is not permitted to access Solution Hub." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getRequest } = await import("@tanstack/react-start/server");
    const address = getRequest().headers.get("cf-connecting-ip");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
    const emailKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const networkDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address ?? "unknown"));
    const networkKey = Array.from(new Uint8Array(networkDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: permitted, error: limitError } = await supabaseAdmin.rpc("consume_request_quota", {
      _kind: "password", _subject: emailKey, _network: networkKey,
    });
    if (limitError || !permitted) return { ok: false as const, error: "Too many requests. Please try again later." };
    const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: false,
      password: crypto.randomUUID() + crypto.randomUUID(),
    });
    if (createErr && !/already|registered|exists/i.test(createErr.message)) {
      console.error("createUser failed", createErr.message);
      return { ok: false as const, error: "Could not prepare your account. Please try again." };
    }
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) {
      console.error("reset failed", error.message);
      return { ok: false as const, error: "Could not send the email. Please try again shortly." };
    }
    return { ok: true as const };
  });
