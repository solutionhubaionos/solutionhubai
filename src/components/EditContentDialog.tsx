import { useState } from "react";
import { Pencil } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import type { ContentItem } from "@/lib/content";
import { CONTENT_TYPES } from "@/lib/industries";

export function EditContentDialog({ item }: { item: ContentItem }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [solution, setSolution] = useState(item.solution ?? "");
  const [description, setDescription] = useState(item.description ?? "");
  const [type, setType] = useState(item.content_type);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("content_items")
        .update({
          title: title.trim(),
          solution: solution.trim() || null,
          description: description.trim() || null,
          content_type: type,
        })
        .eq("id", item.id)
        .select("id")
        .single();
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["content"] });
      toast.success("Content updated");
      setOpen(false);
    } catch {
      toast.error("Could not update content.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        setOpen(value);
        setTitle(item.title);
        setSolution(item.solution ?? "");
        setDescription(item.description ?? "");
        setType(item.content_type);
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="Edit content" title="Edit content">
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit content</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-title">Title</Label>
            <Input
              id="edit-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-solution">Solution</Label>
            <Input
              id="edit-solution"
              maxLength={200}
              value={solution}
              onChange={(e) => setSolution(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-type">Content type</Label>
            <select
              id="edit-type"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {CONTENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <Button className="w-full" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
