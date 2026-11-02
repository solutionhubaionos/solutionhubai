import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import hero from "@/assets/hero.webp";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { ALLOWED_DOMAINS, isAllowedEmail } from "@/lib/domains";
import { requestPasswordLink } from "@/lib/auth.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Solution Hub" },
      { name: "description", content: "Sign in to Solution Hub with your company email." },
      { property: "og:title", content: "Sign in — Solution Hub" },
      { property: "og:description", content: "Sign in to Solution Hub with your company email." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

const DOMAIN_ERROR = "Only company emails can access Solution Hub.";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!isAllowedEmail(email)) { toast.error(DOMAIN_ERROR); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) { toast.error("Incorrect email or password. First time? Use “Set / reset password”."); return; }
    navigate({ to: "/library", replace: true });
  }

  async function onReset(e: React.FormEvent) {
    e.preventDefault();
    if (!isAllowedEmail(email)) { toast.error(DOMAIN_ERROR); return; }
    setLoading(true);
    try {
      const res = await requestPasswordLink({ data: { email: email.trim(), origin: window.location.origin } });
      if (!res.ok) toast.error(res.error);
      else setSent(true);
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-ink lg:block">
        <img src={hero} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-ink" />
        <div className="absolute bottom-0 p-12">
          <h2 className="text-3xl font-bold text-ink-foreground">Win more with proven stories.</h2>
          <p className="mt-3 max-w-md text-ink-foreground/75">Your team's case studies, decks, POC videos and proposals — organized by industry.</p>
        </div>
      </div>
      <div className="flex flex-col px-6 py-8">
        <Logo />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
          {mode === "signin" ? (
            <>
              <h1 className="text-3xl font-bold">Sign in</h1>
              <p className="mt-2 text-sm text-muted-foreground">Use your company email and password.</p>
              <form onSubmit={onSignIn} className="mt-8 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Work email</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@aionos.ai" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button>
              </form>
              <div className="mt-6 rounded-xl bg-secondary p-4 text-sm">
                <p className="font-semibold text-secondary-foreground">First time here or forgot your password?</p>
                <Button variant="link" className="h-auto p-0" onClick={() => { setMode("reset"); setSent(false); }}>
                  Set / reset password →
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold">Set your password</h1>
              <p className="mt-2 text-sm text-muted-foreground">We'll email you a secure link to create or reset your password.</p>
              {sent ? (
                <div className="mt-8 rounded-xl border bg-card p-5">
                  <p className="font-semibold">Check your inbox</p>
                  <p className="mt-1 text-sm text-muted-foreground">We sent a link to {email}. Open it to set your password.</p>
                </div>
              ) : (
                <form onSubmit={onReset} className="mt-8 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="remail">Work email</Label>
                    <Input id="remail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>{loading ? "Sending…" : "Email me a link"}</Button>
                </form>
              )}
              <Button variant="link" className="mt-4 h-auto self-start p-0" onClick={() => setMode("signin")}>← Back to sign in</Button>
            </>
          )}
          <p className="mt-10 text-xs text-muted-foreground">Access is limited to: {ALLOWED_DOMAINS.join(", ")}</p>
        </div>
      </div>
    </div>
  );
}
