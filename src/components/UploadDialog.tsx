import { useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { ACCEPTED_FILES, CONTENT_TYPES, useIndustries } from "@/lib/industries";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { uploadDestination } from "@/lib/upload-destination";

export function UploadDialog({
  industry,
  customers = [],
  defaultCustomer = "",
  trigger,
}: {
  industry?: string;
  customers?: string[];
  defaultCustomer?: string;
  trigger?: ReactNode;
}) {
  const { industries: INDUSTRIES } = useIndustries();
  const { user } = useRouteContext({ from: "/_authenticated" });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ind, setInd] = useState(industry ?? "");
  const [type, setType] = useState("case_study");
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState(defaultCustomer ? "company" : "industry");
  const [customer, setCustomer] = useState(defaultCustomer);
  const destinationIndustry = industry || ind;
  const industryName =
    INDUSTRIES.find((i) => i.slug === destinationIndustry)?.name ?? "Select industry";

  function changeOpen(value: boolean) {
    if (busy) return;
    if (value) {
      setInd(industry ?? "");
      setScope(defaultCustomer ? "company" : "industry");
      setCustomer(defaultCustomer);
      setFile(null);
      setType("case_study");
    }
    setOpen(value);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (!file) {
      toast.error("Choose a file");
      return;
    }
    let destination;
    try {
      destination = uploadDestination(industry, ind, scope, customer);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Choose a destination");
      return;
    }
    setBusy(true);
    try {
      const safe = file.name.replace(/[^\w.-]+/g, "_");
      const path = `${user.id}/${destination.industry}/${crypto.randomUUID()}-${safe}`;
      const up = await supabase.storage
        .from("content")
        .upload(path, file, file.type ? { contentType: file.type } : {});
      if (up.error) throw up.error;
      const { error } = await supabase.from("content_items").insert({
        ...destination,
        title: String(fd.get("title") || "").trim() || file.name,
        solution: String(fd.get("solution") || "").trim() || null,
        description: String(fd.get("description") || "").trim() || null,
        content_type: type,
        file_path: path,
        file_name: file.name,
        mime_type: file.type || null,
        file_size: file.size,
        uploaded_by: user.id,
        uploader_email: user.email ?? null,
      });
      if (error) {
        await supabase.storage.from("content").remove([path]);
        throw error;
      }
      const cust = destination.customer_name;
      const isNew = cust && !customers.some((c) => c.toLowerCase() === cust.toLowerCase());
      if (isNew) {
        await supabase
          .from("customers")
          .insert({ industry: destination.industry, name: cust, created_by: user.id });
        qc.invalidateQueries({ queryKey: ["customers"] });
      }
      toast.success(`Uploaded to ${industryName} · ${cust || "Industry-wide"}`);
      qc.invalidateQueries({ queryKey: ["content"] });
      setOpen(false);
      setFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="accent">
            <Upload /> Upload content
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] max-w-lg overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Upload content</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Industry</Label>
              {industry ? (
                <p className="flex min-h-9 items-center text-sm font-medium">{industryName}</p>
              ) : (
                <Select
                  value={destinationIndustry}
                  onValueChange={(value) => {
                    setInd(value);
                    setCustomer("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDUSTRIES.map((i) => (
                      <SelectItem key={i.slug} value={i.slug}>
                        {i.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTENT_TYPES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Upload to</legend>
            <RadioGroup value={scope} onValueChange={setScope} className="grid-cols-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="industry" id="scope-industry" />
                <Label htmlFor="scope-industry">Industry-wide</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="company" id="scope-company" />
                <Label htmlFor="scope-company">Company</Label>
              </div>
            </RadioGroup>
            {scope === "company" && (
              <div className="space-y-2">
                <Label htmlFor="customer">Company</Label>
                <Input
                  id="customer"
                  name="customer"
                  list="customer-list"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                  required
                  placeholder="Select or enter a new company"
                />
                <datalist id="customer-list">
                  {customers.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            )}
            <p className="break-words text-sm font-medium text-primary">
              {industryName} ·{" "}
              {scope === "company" ? customer || "Select company" : "Industry-wide"}
            </p>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" name="title" placeholder="e.g. Digital check-in transformation" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="solution">Solution</Label>
            <Input
              id="solution"
              name="solution"
              placeholder="e.g. AI chatbot, Revenue management"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={3} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="file">File (PPT, Doc, XLS, PDF, image, video)</Label>
            <Input
              id="file"
              type="file"
              accept={ACCEPTED_FILES}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
