import { useState } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { checkAdminAccess } from "@/lib/admin-content";
import { deleteContent, type ContentItem } from "@/lib/content";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";

export function AdminDeleteFileDialog({ item }: { item: ContentItem }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function remove() {
    setBusy(true);
    try {
      if (!(await checkAdminAccess())) throw new Error("Administrator access required.");
      const { storageError } = await deleteContent(item);
      if (storageError)
        toast.warning(
          "File removed from the library, but storage cleanup failed. Storage may still be in use.",
        );
      else toast.success("File deleted");
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ["content"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete this file.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title="Delete file"
        aria-label={`Delete ${item.title}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="text-destructive" />
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              “{item.title}” will be permanently removed from the library and its stored file
              deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={remove}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}{" "}
              {busy ? "Deleting…" : "Delete file"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
