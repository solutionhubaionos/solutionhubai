import { useEffect, useState } from "react";
import { Copy, FolderInput } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import type { ContentItem } from "@/lib/content";
import { useIndustries } from "@/lib/industries";

type Mode = "move" | "copy";

export function MoveCopyDialog({ item, canMove }: { item: ContentItem; canMove: boolean }) {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const { industries } = useIndustries();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(canMove ? "move" : "copy");
  const [industry, setIndustry] = useState(item.industry);
  const [customer, setCustomer] = useState(item.customer_name ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setIndustry(item.industry);
      setCustomer(item.customer_name ?? "");
      setMode(canMove ? "move" : "copy");
    }
  }, [open, item, canMove]);

  const { data: customers = [] } = useQuery({
    queryKey: ["customers", "names", industry],
    enabled: open,
    queryFn: async () => {
      const [a, b] = await Promise.all([
        supabase.from("customers").select("name").eq("industry", industry),
        supabase
          .from("content_items")
          .select("customer_name")
          .eq("industry", industry)
          .not("customer_name", "is", null),
      ]);
      const names = new Set<string>();
      a.data?.forEach((r) => names.add(r.name));
      b.data?.forEach((r) => r.customer_name && names.add(r.customer_name));
      return [...names].sort((x, y) => x.localeCompare(y));
    },
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cust = customer.trim().replace(/\s+/g, " ") || null;
    if (mode === "move" && industry === item.industry && cust === (item.customer_name || null)) {
      toast.error("Pick a different industry or customer.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "move") {
        const { error } = await supabase
          .from("content_items")
          .update({ industry, customer_name: cust })
          .eq("id", item.id)
          .select("id")
          .single();
        if (error) throw error;
      } else {
        const newPath = `${user.id}/${crypto.randomUUID()}-${item.file_name}`;
        const { error: cpErr } = await supabase.storage
          .from("content")
          .copy(item.file_path, newPath);
        if (cpErr) throw cpErr;
        const { error } = await supabase.from("content_items").insert({
          industry,
          customer_name: cust,
          title: item.title,
          solution: item.solution,
          description: item.description,
          content_type: item.content_type,
          file_path: newPath,
          file_name: item.file_name,
          mime_type: item.mime_type,
          file_size: item.file_size,
          uploaded_by: user.id,
          uploader_email: user.email ?? null,
        });
        if (error) {
          await supabase.storage.from("content").remove([newPath]);
          throw error;
        }
      }
      const where = `${industries.find((i) => i.slug === industry)?.name ?? industry}${cust ? ` · ${cust}` : ""}`;
      toast.success(`${mode === "move" ? "Moved" : "Copied"} to ${where}`);
      await qc.invalidateQueries({ queryKey: ["content"] });
      await qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false);
    } catch {
      toast.error(`Could not ${mode} this file.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="Move or copy" title="Move or copy">
          <FolderInput />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move or copy “{item.title}”</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={mode === "move" ? "default" : "outline"}
              disabled={!canMove}
              onClick={() => setMode("move")}
            >
              <FolderInput /> Move
            </Button>
            <Button
              type="button"
              variant={mode === "copy" ? "default" : "outline"}
              onClick={() => setMode("copy")}
            >
              <Copy /> Copy
            </Button>
          </div>
          {!canMove && (
            <p className="text-xs text-muted-foreground">
              Only the uploader or an admin can move this file. You can make a copy.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="mc-industry">Industry</Label>
            <select
              id="mc-industry"
              value={industry}
              onChange={(e) => {
                setIndustry(e.target.value);
                setCustomer("");
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {industries.map((i) => (
                <option key={i.slug} value={i.slug}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mc-customer">Customer</Label>
            <Input
              id="mc-customer"
              list="mc-customers"
              maxLength={80}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="Leave empty for industry-wide"
            />
            <datalist id="mc-customers">
              {customers.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Working…" : mode === "move" ? "Move here" : "Copy here"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
