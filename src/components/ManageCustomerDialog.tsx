import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export function ManageCustomerDialog({
  industry,
  name,
  onChanged,
}: {
  industry: string;
  name: string;
  onChanged: (name: string | null) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save(remove: boolean) {
    const cleaned = newName.trim().replace(/\s+/g, " ");
    if (!remove && (cleaned.length < 2 || cleaned.length > 80)) {
      toast.error("Enter a company name of 2–80 characters.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("manage_company", {
        _industry: industry,
        _name: name,
        _new_name: cleaned,
        _delete: remove,
      });
      if (error) throw error;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["customers"] }),
        qc.invalidateQueries({ queryKey: ["content"] }),
      ]);
      onChanged(remove ? null : cleaned);
      toast.success(
        remove ? "Company deleted. Its files are now industry-wide." : "Company updated",
      );
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update company.");
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
        setNewName(name);
        setDeleting(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={`Manage ${name}`}
          title={`Manage ${name}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{deleting ? "Delete company" : "Edit company"}</DialogTitle>
        </DialogHeader>
        {deleting ? (
          <div className="space-y-4">
            <p className="text-sm">
              Delete “{name}”? Its files will be kept as industry-wide content in the same industry.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void save(true)}>
                {busy ? "Deleting…" : "Delete company"}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="edit-company-name">Company name</Label>
              <Input
                id="edit-company-name"
                value={newName}
                maxLength={80}
                required
                onChange={(event) => setNewName(event.target.value)}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash2 /> Delete
              </Button>
              <Button disabled={busy}>{busy ? "Saving…" : "Save company"}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
