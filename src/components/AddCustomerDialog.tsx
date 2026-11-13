import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
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

export function AddCustomerDialog({
  industry,
  industryName,
  onAdded,
}: {
  industry: string;
  industryName: string;
  onAdded?: (name: string) => void;
}) {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim().replace(/\s+/g, " ");
    if (n.length < 2) {
      toast.error("Enter a customer name");
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("customers")
      .insert({ industry, name: n, created_by: user.id });
    setBusy(false);
    if (error) {
      toast.error(
        error.code === "23505" ? "That customer already exists here." : "Could not add customer.",
      );
      return;
    }
    toast.success(`${n} added`);
    await qc.invalidateQueries({ queryKey: ["customers"] });
    onAdded?.(n);
    setName("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start">
          <Plus /> Add customer
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a customer to {industryName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cust-name">Customer name</Label>
            <Input
              id="cust-name"
              autoFocus
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Indigo Airlines"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Adding…" : "Add customer"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
