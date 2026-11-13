import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import {
  Search,
  HardDrive,
  Files,
  FilterX,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import {
  adminAccessQuery,
  adminContentQuery,
  filterAdminFiles,
  storageSummary,
  type AdminFilters,
} from "@/lib/admin-content";
import { industriesQuery } from "@/lib/industries";
import { formatSize, mergeCustomerNames } from "@/lib/content";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { FilePreviewDialog } from "@/components/FilePreviewDialog";
import { AdminDeleteFileDialog } from "@/components/AdminDeleteFileDialog";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);
export const Route = createFileRoute("/_authenticated/admin")({
  validateSearch: z.object({
    q: z.string().optional(),
    industry: z.string().optional(),
    customer: z.string().optional(),
    from: date,
    to: date,
    sort: z.enum(["newest", "oldest", "largest", "smallest"]).optional(),
    page: z.number().int().min(1).catch(1).optional(),
  }),
  beforeLoad: async ({ context }) => {
    const allowed = await context.queryClient.fetchQuery(adminAccessQuery);
    if (!allowed) throw redirect({ to: "/library" });
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(adminContentQuery),
      context.queryClient.ensureQueryData(industriesQuery),
    ]);
  },
  head: () => ({
    meta: [
      { title: "Admin dashboard — Solution Hub" },
      {
        name: "description",
        content:
          "Manage Solution Hub files by industry, customer and upload date, and review file storage usage.",
      },
      { property: "og:title", content: "Admin dashboard — Solution Hub" },
      {
        property: "og:description",
        content: "Admin file management and storage usage for Solution Hub.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  errorComponent: AdminError,
  notFoundComponent: () => (
    <main className="mx-auto max-w-7xl p-6">
      <h1>Dashboard not found</h1>
      <Link to="/library">Return to library</Link>
    </main>
  ),
  pendingComponent: () => (
    <main className="mx-auto max-w-7xl p-6 text-muted-foreground">Loading dashboard…</main>
  ),
  component: AdminDashboard,
});

function AdminError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="text-xl font-semibold">Dashboard unavailable</h1>
      <p role="alert" className="my-4 text-destructive">
        {error instanceof Error ? error.message : "Could not load the dashboard."}
      </p>
      <Button onClick={() => router.invalidate()}>Try again</Button>
    </main>
  );
}

function AdminDashboard() {
  const { data: items } = useSuspenseQuery(adminContentQuery);
  const { data: industries } = useSuspenseQuery(industriesQuery);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [view, setView] = useState("files");
  const filtered = filterAdminFiles(items, search);
  const total = storageSummary(items),
    selected = storageSummary(filtered);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const page = Math.min(search.page ?? 1, pageCount);
  const visible = filtered.slice((page - 1) * 25, page * 25);
  const customers = mergeCustomerNames(
    [],
    items
      .filter((i) => !search.industry || i.industry === search.industry)
      .map((i) => i.customer_name),
  );
  const invalidRange = Boolean(search.from && search.to && search.from > search.to);
  function update(patch: Partial<AdminFilters>) {
    void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }), replace: true });
  }
  const size = (bytes: number) => formatSize(bytes) || "0 B";
  const industryName = (slug: string) => industries.find((i) => i.slug === slug)?.name ?? slug;
  const groups = industries
    .map((i) => ({ ...i, ...storageSummary(filtered.filter((f) => f.industry === i.slug)) }))
    .filter((i) => i.files > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-6">
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
            <ShieldCheck className="h-4 w-4" /> Administration
          </p>
          <h1 className="text-3xl font-bold tracking-normal">Admin dashboard</h1>
        </div>
        <Link
          to="/insights"
          className="text-sm font-semibold text-primary underline underline-offset-4"
        >
          Content activity ↗
        </Link>
      </div>
      <section
        aria-label="Storage totals"
        className="grid divide-y border-b sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      >
        {[
          {
            label: "Library storage",
            value: size(total.bytes),
            detail: `${total.files} stored files${total.unknown ? ` · ${total.unknown} unknown sizes` : ""}`,
            icon: HardDrive,
          },
          {
            label: "Matching storage",
            value: size(selected.bytes),
            detail: `${selected.files} matching files${selected.unknown ? ` · ${selected.unknown} unknown sizes` : ""}`,
            icon: HardDrive,
          },
          {
            label: "Library files",
            value: String(items.length),
            detail: `${filtered.length} matching results`,
            icon: Files,
          },
        ].map(({ label, value, detail, icon: Icon }) => (
          <div key={label} className="py-6 sm:px-6 first:pl-0">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon className="h-4 w-4" />
              {label}
            </p>
            <p className="mt-2 text-3xl font-bold tracking-normal tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
          </div>
        ))}
      </section>
      <section aria-label="File filters" className="space-y-4 border-b py-6">
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search files"
            placeholder="Search files, customers or solutions"
            value={search.q ?? ""}
            onChange={(e) => update({ q: e.target.value || undefined })}
            className="pl-9"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-2">
            <Label>Industry</Label>
            <Select
              value={search.industry ?? "__all__"}
              onValueChange={(v) =>
                update({ industry: v === "__all__" ? undefined : v, customer: undefined })
              }
            >
              <SelectTrigger aria-label="Filter industry" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All industries</SelectItem>
                {industries.map((i) => (
                  <SelectItem key={i.slug} value={i.slug}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Customer</Label>
            <Select
              value={search.customer ?? "__all__"}
              onValueChange={(v) => update({ customer: v === "__all__" ? undefined : v })}
            >
              <SelectTrigger aria-label="Filter customer" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All customers</SelectItem>
                <SelectItem value="__industry_wide__">Industry-wide</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-from">Uploaded from (UTC)</Label>
            <Input
              id="admin-from"
              type="date"
              value={search.from ?? ""}
              max={search.to}
              onChange={(e) => update({ from: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-to">Uploaded through (UTC)</Label>
            <Input
              id="admin-to"
              type="date"
              value={search.to ?? ""}
              min={search.from}
              onChange={(e) => update({ to: e.target.value || undefined })}
            />
          </div>
          <div className="space-y-2">
            <Label>Sort by</Label>
            <Select
              value={search.sort ?? "newest"}
              onValueChange={(v) => {
                if (v === "newest" || v === "oldest" || v === "largest" || v === "smallest")
                  update({ sort: v });
              }}
            >
              <SelectTrigger aria-label="Sort files" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="largest">Largest first</SelectItem>
                <SelectItem value="smallest">Smallest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {invalidRange && (
          <p role="alert" className="text-sm text-destructive">
            The end date must be on or after the start date.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1" role="tablist" aria-label="Dashboard view">
            <Button
              role="tab"
              aria-selected={view === "files"}
              variant={view === "files" ? "secondary" : "ghost"}
              onClick={() => setView("files")}
            >
              Files
            </Button>
            <Button
              role="tab"
              aria-selected={view === "storage"}
              variant={view === "storage" ? "secondary" : "ghost"}
              onClick={() => setView("storage")}
            >
              <HardDrive />
              Storage report
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate({ search: {}, replace: true })}>
            <FilterX />
            Clear filters
          </Button>
        </div>
      </section>
      {view === "storage" && (
        <section className="border-b py-6">
          <h2 className="text-lg font-semibold">Storage by industry</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Uploaded content only; cover images and any unlinked stored files are excluded. Sizes
            are recorded at upload.
          </p>
          <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
            {groups.map((i) => (
              <div key={i.slug} className="flex items-center justify-between gap-4 border-b py-3">
                <span className="min-w-0 break-words text-sm">
                  {i.name}
                  <span className="block text-xs text-muted-foreground">
                    {i.files} files{i.unknown ? ` · ${i.unknown} unknown sizes` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{size(i.bytes)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {view === "storage" ? "File storage usage" : "Uploaded files"}
          </h2>
          <p className="text-sm text-muted-foreground">{filtered.length} files</p>
        </div>
        {filtered.length === 0 ? (
          <div className="border-y py-14 text-center">
            <Files className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-semibold">
              {items.length ? "No matching files" : "No uploaded files yet"}
            </h3>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-y bg-muted text-muted-foreground">
                  <tr>
                    {["File", "Industry / customer", "Uploaded (UTC)", "Storage", "Actions"].map(
                      (h) => (
                        <th key={h} scope="col" className="px-3 py-3 font-medium">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="max-w-72 px-3 py-4">
                        <FilePreviewDialog
                          item={item}
                          trigger={
                            <Button
                              variant="link"
                              className="h-auto max-w-full justify-start whitespace-normal p-0 text-left font-semibold"
                            >
                              {item.title}
                            </Button>
                          }
                        />
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {item.file_name}
                        </p>
                        {item.solution && (
                          <p className="mt-1 break-words text-xs text-primary">{item.solution}</p>
                        )}
                      </td>
                      <td className="max-w-56 px-3 py-4">
                        <p className="break-words">{industryName(item.industry)}</p>
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {item.customer_name || "Industry-wide"}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 tabular-nums">
                        {item.created_at.slice(0, 10)}
                      </td>
                      <td
                        className="whitespace-nowrap px-3 py-4 font-semibold tabular-nums"
                        title={
                          item.file_size == null
                            ? "Size not recorded"
                            : `${item.file_size.toLocaleString()} bytes`
                        }
                      >
                        {item.file_size == null ? "Unknown" : size(item.file_size)}
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex items-center gap-1">
                          <FilePreviewDialog item={item} />
                          <AdminDeleteFileDialog item={item} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() => navigate({ search: (prev) => ({ ...prev, page: page - 1 }) })}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next page"
                  disabled={page === pageCount}
                  onClick={() => navigate({ search: (prev) => ({ ...prev, page: page + 1 }) })}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
