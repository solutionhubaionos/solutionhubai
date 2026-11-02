import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createIndustry } from "@/lib/industries.functions";

export function AddIndustryDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await createIndustry({ data: { name, tagline: tagline || undefined } });
      if (!res.ok) { toast.error(res.error); return; }
      await qc.invalidateQueries({ queryKey: ["industries"] });
      toast.success(res.imageFailed ? `${name} added (image couldn't be generated)` : `${name} added`);
      setOpen(false); setName(""); setTagline("");
      navigate({ to: "/industry/$slug", params: { slug: res.slug } });
    } catch {
      toast.error("Could not add industry. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button variant="outline"><Plus /> Add industry</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add a new industry</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ind-name">Industry name</Label>
            <Input id="ind-name" required minLength={2} maxLength={50} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Healthcare" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ind-tag">Short description <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="ind-tag" maxLength={80} value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="e.g. Hospitals, pharma & patient care" />
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Sparkles className="h-4 w-4 text-accent" /> A cover image is created automatically — this can take up to a minute.</p>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Creating industry & image…" : "Add industry"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
