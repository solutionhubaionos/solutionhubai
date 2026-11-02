import { FileText, FileSpreadsheet, Presentation, Image as ImageIcon, PlayCircle, File, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { type ContentItem, formatSize } from "@/lib/content";
import { FilePreviewDialog } from "@/components/FilePreviewDialog";
import { MoveCopyDialog } from "@/components/MoveCopyDialog";
import { contentTypeLabel, useIndustries } from "@/lib/industries";
import { useRole } from "@/lib/roles";
import { canManageContent } from "@/lib/permissions";
import { EditContentDialog } from "@/components/EditContentDialog";

function iconFor(item: ContentItem) {
  const m = item.mime_type ?? "";
  const n = item.file_name.toLowerCase();
  if (m.startsWith("video/")) return PlayCircle;
  if (m.startsWith("image/")) return ImageIcon;
  if (/\.pptx?$/.test(n)) return Presentation;
  if (/\.(xlsx?|csv)$/.test(n)) return FileSpreadsheet;
  if (/\.(docx?|pdf)$/.test(n)) return FileText;
  return File;
}

export function ContentCard({ item, showIndustry = false }: { item: ContentItem; showIndustry?: boolean }) {
  const Icon = iconFor(item);
  const { industries } = useIndustries();
  const qc = useQueryClient();
  const { user } = useRouteContext({ from: "/_authenticated" });
  const { role, isAdmin } = useRole();
  const canManage = canManageContent(role, user.id, item.uploaded_by);

  async function remove() {
    if (!confirm(`Delete “${item.title}”?`)) return;
    const { error } = await supabase.from("content_items").delete().eq("id", item.id).select("id").single();
    if (error) { toast.error(error.message); return; }
    const { error: storageError } = await supabase.storage.from("content").remove([item.file_path]);
    if (storageError) toast.warning("Content removed, but its stored file could not be cleaned up.");
    else toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["content"] });
  }

  return (
    <div className="relative flex flex-col rounded-2xl border bg-card p-5 shadow-card">
      <FilePreviewDialog item={item} trigger={<Button variant="ghost" className="absolute inset-0 h-full w-full rounded-2xl" aria-label={`Open ${item.title}`}><span className="sr-only">Open {item.title}</span></Button>} />
      <div className="pointer-events-none relative flex flex-1 flex-col">
      <div className="flex items-center gap-2 text-left">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-secondary text-primary"><Icon className="h-5 w-5" /></span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{item.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{item.file_name} · {formatSize(item.file_size)}</span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="secondary">{contentTypeLabel(item.content_type)}</Badge>
        {showIndustry && <Badge variant="outline">{industries.find((i) => i.slug === item.industry)?.name ?? item.industry}</Badge>}
        <Badge variant="outline">{item.customer_name || "Industry-wide"}</Badge>
      </div>
      {item.solution && <p className="mt-3 text-sm font-medium text-primary">{item.solution}</p>}
      {item.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <span className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleDateString()}</span>
        <div className="pointer-events-auto flex gap-1">
          {isAdmin && <EditContentDialog item={item} />}
          <MoveCopyDialog item={item} canMove={canManage} />
          {canManage && <Button size="icon" variant="ghost" onClick={remove} aria-label="Delete" title="Delete content"><Trash2 /></Button>}
          <FilePreviewDialog item={item} />
        </div>
      </div>
      </div>
    </div>
  );
}
