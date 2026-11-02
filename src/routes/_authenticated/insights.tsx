import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Eye, FileDown, Users, ChevronLeft, ChevronRight } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FilePreviewDialog } from "@/components/FilePreviewDialog";
import { ProgressiveList } from "@/components/ProgressiveList";
import { supabase } from "@/integrations/supabase/client";
import { contentQuery } from "@/lib/content";
import { useIndustries } from "@/lib/industries";
import type { Tables } from "@/integrations/supabase/types";
import { adminAccessQuery } from "@/lib/admin-content";

export const Route = createFileRoute("/_authenticated/insights")({
  validateSearch: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).catch(30), page: z.number().int().min(1).catch(1) }),
  beforeLoad: async ({ context }) => {
    const allowed = await context.queryClient.fetchQuery(adminAccessQuery);
    if (!allowed) throw redirect({ to: "/library" });
  },
  head: () => ({
    meta: [
      { title: "Insights — Solution Hub" },
      { name: "description", content: "See which content and industries your team uses most." },
      { property: "og:title", content: "Insights — Solution Hub" },
      { property: "og:description", content: "See which content and industries your team uses most." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Insights,
});

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

type Summary = {
  opens: number; views: number; people: number;
  files: { content_id: string | null; count: number; people: number }[];
  industries: { industry: string | null; count: number; people: number }[];
  recent: Pick<Tables<"activity_events">, "id" | "user_email" | "event_type" | "industry" | "content_id" | "created_at">[];
};
const EMPTY: Summary = { opens: 0, views: 0, people: 0, files: [], industries: [], recent: [] };

function Insights() {
  const { days, page: requestedPage } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { industries } = useIndustries();
  const { data: content = [] } = useQuery(contentQuery());
  const { data: summary = EMPTY, isLoading } = useQuery({
    queryKey: ["activity", days],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("activity_summary", { _days: days });
      if (error) throw error;
      return data as unknown as Summary;
    },
  });

  const indName = (s: string | null) => industries.find((i) => i.slug === s)?.name ?? s ?? "—";
  const title = (id: string | null) => content.find((c) => c.id === id)?.title ?? "Deleted file";
  const events = summary.recent;
  const pageCount = Math.max(1, Math.ceil(events.length / 10));
  const page = Math.min(requestedPage, pageCount);
  const fileLabel = (id: string | null) => {
    const item = content.find(c => c.id === id);
    return item ? <FilePreviewDialog item={item} trigger={<Button variant="link" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left">{item.title}</Button>} /> : title(id);
  };
  const topFiles = summary.files;
  const topIndustries = summary.industries;
  const stat = "rounded-2xl border bg-card p-5 shadow-card";

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Insights</h1>
          <p className="mt-1 text-muted-foreground">Which content and industries your team actually uses.</p>
        </div>
        <div className="flex gap-2">
          {RANGES.map((r) => (
            <Button size="sm" variant={days === r.days ? "default" : "outline"} key={r.days} onClick={() => navigate({ search: { days: r.days as 7 | 30 | 90, page: 1 }, replace: true })}>
              Last {r.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className={stat}><FileDown className="h-5 w-5 text-primary" /><p className="mt-3 text-3xl font-bold">{summary.opens}</p><p className="text-sm text-muted-foreground">File opens</p></div>
        <div className={stat}><Eye className="h-5 w-5 text-primary" /><p className="mt-3 text-3xl font-bold">{summary.views}</p><p className="text-sm text-muted-foreground">Industry page visits</p></div>
        <div className={stat}><Users className="h-5 w-5 text-primary" /><p className="mt-3 text-3xl font-bold">{summary.people}</p><p className="text-sm text-muted-foreground">Active people</p></div>
      </div>

      {isLoading ? <p className="mt-8 text-muted-foreground">Loading…</p> : (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Panel title="Most opened files" empty={topFiles.length === 0}>
            <ProgressiveList key={`files:${days}`} items={topFiles} batchSize={5} renderItem={({ content_id: id, count, people }) => {
              const c = content.find((x) => x.id === id);
              return <Row key={id ?? "x"} label={fileLabel(id)} sub={c ? `${indName(c.industry)}${c.customer_name ? ` · ${c.customer_name}` : ""}` : ""} count={count} people={people} />;
            }} />
          </Panel>
          <Panel title="Most visited industries" empty={topIndustries.length === 0}>
            <ProgressiveList key={`industries:${days}`} items={topIndustries} batchSize={5} renderItem={({ industry, count, people }) => <Row key={industry ?? "x"} label={indName(industry)} count={count} people={people} />} />
          </Panel>
          <Panel title="Recent activity" empty={events.length === 0} wide>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr><th className="py-2">When</th><th>Who</th><th>Action</th><th>What</th></tr>
              </thead>
              <tbody>
                {events.slice((page - 1) * 10, page * 10).map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{new Date(e.created_at).toLocaleString()}</td>
                    <td className="pr-3">{e.user_email}</td>
                    <td className="pr-3">{e.event_type === "file_open" ? "Opened file" : "Visited industry"}</td>
                    <td>{e.event_type === "file_open" ? fileLabel(e.content_id) : indName(e.industry)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            {pageCount > 1 && <nav aria-label="Activity pages" className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <Button size="icon" variant="outline" aria-label="Previous activity page" disabled={page === 1} onClick={() => navigate({ search: { days, page: page - 1 } })}><ChevronLeft /></Button>
                <Button size="icon" variant="outline" aria-label="Next activity page" disabled={page === pageCount} onClick={() => navigate({ search: { days, page: page + 1 } })}><ChevronRight /></Button>
              </div>
            </nav>}
          </Panel>
        </div>
      )}
    </main>
  );
}

function Panel({ title, empty, wide, children }: { title: string; empty: boolean; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={`rounded-2xl border bg-card p-5 shadow-card ${wide ? "lg:col-span-2" : ""}`}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{empty ? <p className="text-sm text-muted-foreground">No activity in this period yet.</p> : children}</div>
    </section>
  );
}

function Row({ label, sub, count, people }: { label: React.ReactNode; sub?: string; count: number; people: number }) {
  return (
    <div className="border-t py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0"><span className="block truncate font-medium">{label}</span>{sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}</span>
        <span className="shrink-0 text-sm"><b>{count}</b> <span className="text-muted-foreground">· {people} people</span></span>
      </div>
    </div>
  );
}
