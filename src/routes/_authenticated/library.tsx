import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { z } from "zod";
import hero from "@/assets/hero.webp";
import { Input } from "@/components/ui/input";
import { ContentCard } from "@/components/ContentCard";
import { AddIndustryDialog } from "@/components/AddIndustryDialog";
import { contentQuery, matches, sortByDate, type DateSort } from "@/lib/content";
import { DateSortToggle } from "@/components/DateSortToggle";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useIndustries } from "@/lib/industries";
import { ProgressiveList } from "@/components/ProgressiveList";

export const Route = createFileRoute("/_authenticated/library")({
  validateSearch: z.object({ q: z.string().optional() }),
  head: () => ({
    links: [{ rel: "preload", as: "image", href: hero, fetchPriority: "high" }],
    meta: [
      { title: "Library — Solution Hub" },
      { name: "description", content: "Search all sales content by customer or solution." },
      { property: "og:title", content: "Library — Solution Hub" },
      { property: "og:description", content: "Search all sales content by customer or solution." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Library,
});

function Library() {
  const { industries: INDUSTRIES } = useIndustries();
  const { q: urlQuery = "" } = Route.useSearch();
  const [q, setQ] = useState(urlQuery);
  const navigate = Route.useNavigate();
  useEffect(() => { setQ(urlQuery); }, [urlQuery]);
  const saveSearch = () => {
    if (q !== urlQuery) void navigate({ search: { q: q || undefined }, replace: true });
  };
  const { data = [], isLoading } = useQuery(contentQuery());
  const [sort, setSort] = useState<DateSort>("newest");
  const searchTerm = useDeferredValue(q);
  const results = useMemo(() => sortByDate(data.filter((i) => matches(i, searchTerm)), sort), [data, searchTerm, sort]);
  const counts = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const item of data) totals[item.industry] = (totals[item.industry] ?? 0) + 1;
    return totals;
  }, [data]);

  return (
    <main>
      <section className="relative overflow-hidden bg-ink">
        <img src={hero} alt="" fetchPriority="high" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="relative mx-auto max-w-7xl px-6 py-14">
          <h1 className="text-3xl font-bold text-ink-foreground md:text-4xl">Find the right story for your next pitch</h1>
          <div className="mt-6 flex max-w-2xl flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onBlur={saveSearch}
                onKeyDown={(e) => { if (e.key === "Enter") saveSearch(); }}
                aria-label="Search by customer or solution"
                placeholder="Search by customer or solution…"
                className="h-11 bg-card pl-9"
              />
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-6 py-10">
        {q ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">{results.length} result{results.length === 1 ? "" : "s"} for “{searchTerm}”</h2><DateSortToggle value={sort} onChange={setSort} /></div>
            <ProgressiveList key={`${searchTerm}:${sort}`} items={results} className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" renderItem={(i) => <ContentCard key={i.id} item={i} showIndustry />} />
            {results.length === 0 && <p className="mt-6 text-muted-foreground">No content matches yet. Try another customer or solution name.</p>}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3"><h2 className="text-2xl font-bold">Industries</h2><AddIndustryDialog /></div>
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {INDUSTRIES.map((i) => (
                <Link key={i.slug} to="/industry/$slug" params={{ slug: i.slug }} className="group relative aspect-[16/11] overflow-hidden rounded-2xl shadow-card">
                  <img src={i.image} alt={i.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-ink" />
                  <div className="absolute bottom-0 p-4">
                    <h3 className="text-lg font-semibold text-ink-foreground">{i.name}</h3>
                    <p className="text-xs text-ink-foreground/75">{counts[i.slug] ?? 0} items</p>
                  </div>
                </Link>
              ))}
            </div>
            <div className="mt-14 flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-bold">Recently added</h2><DateSortToggle value={sort} onChange={setSort} /></div>
            {isLoading ? (
              <p className="mt-4 text-muted-foreground">Loading…</p>
            ) : data.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
                No content yet.
              </div>
            ) : (
              <ProgressiveList key={`recent:${sort}`} items={sortByDate(data, sort)} batchSize={9} className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" renderItem={(i) => <ContentCard key={i.id} item={i} showIndustry />} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
