import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { logActivity } from "@/lib/activity";
import { Building2, Globe2, Search, House, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ContentCard } from "@/components/ContentCard";
import { UploadDialog } from "@/components/UploadDialog";
import {
  contentQuery,
  matches,
  mergeCustomerNames,
  sortByDate,
  type DateSort,
} from "@/lib/content";
import { supabase } from "@/integrations/supabase/client";
import { AddCustomerDialog } from "@/components/AddCustomerDialog";
import { DateSortToggle } from "@/components/DateSortToggle";
import { CONTENT_TYPES, industriesQuery, type Industry } from "@/lib/industries";
import { useRole } from "@/lib/roles";
import { ManageCustomerDialog } from "@/components/ManageCustomerDialog";
import { Button } from "@/components/ui/button";
import { ProgressiveList } from "@/components/ProgressiveList";

export const Route = createFileRoute("/_authenticated/industry/$slug")({
  loader: async ({ params, context }) => {
    const list = await context.queryClient.ensureQueryData(industriesQuery);
    const industry = list.find((i) => i.slug === params.slug);
    if (!industry) throw notFound();
    return { industry };
  },
  head: ({ loaderData }) => {
    const name = loaderData?.industry.name ?? "Industry";
    return {
      meta: [
        { title: `${name} — Solution Hub` },
        {
          name: "description",
          content: `${name} case studies, pitch decks, POC videos and proposals.`,
        },
        { property: "og:title", content: `${name} — Solution Hub` },
        {
          property: "og:description",
          content: `${name} case studies, pitch decks, POC videos and proposals.`,
        },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
      ],
    };
  },
  component: IndustryPage,
});

const ALL = "__all";
const GENERAL = "__general";

function IndustryPage() {
  const { industry } = Route.useLoaderData();
  return <IndustryContent key={industry.slug} industry={industry} />;
}

function IndustryContent({ industry }: { industry: Industry }) {
  const { isAdmin } = useRole();
  useEffect(() => {
    void logActivity({ event_type: "industry_view", industry: industry.slug });
  }, [industry.slug]);
  const { data = [], isLoading } = useQuery(contentQuery(industry.slug));
  const [customer, setCustomer] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<DateSort>("newest");

  const { data: saved = [] } = useQuery({
    queryKey: ["customers", industry.slug],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("name")
        .eq("industry", industry.slug);
      if (error) throw error;
      return data.map((c) => c.name);
    },
  });
  const customers = mergeCustomerNames(
    saved,
    data.map((item) => item.customer_name),
  );
  const filtered = sortByDate(
    data.filter(
      (d) =>
        (customer === ALL ||
          (customer === GENERAL ? !d.customer_name : d.customer_name === customer)) &&
        (type === ALL || d.content_type === type) &&
        matches(d, q),
    ),
    sort,
  );

  const chip = (active: boolean) =>
    `flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${active ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`;

  return (
    <main>
      <nav
        aria-label="Breadcrumb"
        className="mx-auto flex max-w-7xl items-center gap-2 px-6 py-3 text-sm"
      >
        <Button asChild variant="ghost" size="sm">
          <Link to="/library">
            <House className="h-4 w-4" />
            Home
          </Link>
        </Button>
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span aria-current="page" className="min-w-0 break-words text-muted-foreground">
          {industry.name}
        </span>
      </nav>
      <section className="relative h-72 overflow-hidden bg-ink">
        <img
          src={industry.image}
          alt={industry.name}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="relative mx-auto flex h-full max-w-7xl flex-col justify-end px-6 pb-10">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Industry</p>
          <h1 className="mt-2 text-4xl font-bold text-ink-foreground md:text-5xl">
            {industry.name}
          </h1>
          <p className="mt-2 text-ink-foreground/80">{industry.tagline}</p>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl gap-8 px-6 py-10 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-6">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Browse
            </h2>
            <Button
              variant="ghost"
              className={`${chip(customer === ALL)} h-auto`}
              onClick={() => setCustomer(ALL)}
            >
              All content <span>{data.length}</span>
            </Button>
            <Button
              variant="ghost"
              className={`${chip(customer === GENERAL)} h-auto`}
              onClick={() => setCustomer(GENERAL)}
            >
              <span className="flex items-center gap-2">
                <Globe2 className="h-4 w-4" /> Industry-wide
              </span>
              <span>{data.filter((d) => !d.customer_name).length}</span>
            </Button>
          </div>
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Customers
            </h2>
            {customers.length === 0 && (
              <p className="px-3 text-sm text-muted-foreground">No customers yet.</p>
            )}
            {customers.map((c) => (
              <div key={c} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  className={`${chip(customer === c)} h-auto min-w-0 flex-1 whitespace-normal`}
                  onClick={() => setCustomer(c)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Building2 className="h-4 w-4 shrink-0" />
                    <span className="break-words">{c}</span>
                  </span>
                  <span className="shrink-0">
                    {data.filter((d) => d.customer_name === c).length}
                  </span>
                </Button>
                {isAdmin && (
                  <ManageCustomerDialog
                    industry={industry.slug}
                    name={c}
                    onChanged={(name) => {
                      if (customer === c) setCustomer(name ?? GENERAL);
                    }}
                  />
                )}
              </div>
            ))}
            <AddCustomerDialog
              industry={industry.slug}
              industryName={industry.name}
              onAdded={setCustomer}
            />
          </div>
        </aside>

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {customer === ALL
                ? "All content"
                : customer === GENERAL
                  ? "Industry-wide content"
                  : customer}
            </h2>
            <UploadDialog
              industry={industry.slug}
              customers={customers}
              defaultCustomer={customer !== ALL && customer !== GENERAL ? customer : ""}
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${industry.name} by customer or solution…`}
                className="pl-9"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <DateSortToggle value={sort} onChange={setSort} />
            {[{ value: ALL, label: "All types" }, ...CONTENT_TYPES].map((t) => (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${type === t.value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-secondary"}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {isLoading ? (
            <p className="mt-8 text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <div className="mt-8 rounded-2xl border border-dashed p-12 text-center text-muted-foreground">
              Nothing here yet. Upload industry-wide or customer-specific content for{" "}
              {industry.name}.
            </div>
          ) : (
            <ProgressiveList
              key={`${customer}:${type}:${q}:${sort}`}
              items={filtered}
              className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3"
              renderItem={(i) => <ContentCard key={i.id} item={i} />}
            />
          )}
        </section>
      </div>
    </main>
  );
}
