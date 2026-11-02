import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { adminAccessQuery } from "@/lib/admin-content";
import { industriesQuery } from "@/lib/industries";
import { searchLibrary, type SearchLibraryResult } from "@/lib/rag/search.functions";
import type { RetrievedChunk } from "@/lib/rag/search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Temporary debug surface for retrieval quality; remove once chat ships.
export const Route = createFileRoute("/_authenticated/rag-debug")({
  beforeLoad: async ({ context }) => {
    const allowed = await context.queryClient.fetchQuery(adminAccessQuery);
    if (!allowed) throw redirect({ to: "/library" });
  },
  loader: async ({ context }) => ({
    industries: await context.queryClient.ensureQueryData(industriesQuery),
  }),
  head: () => ({
    meta: [{ title: "Retrieval debug — Solution Hub" }, { name: "robots", content: "noindex" }],
  }),
  component: RagDebugPage,
});

const ANY = "__any__";

function RagDebugPage() {
  const [query, setQuery] = useState("");
  const [industry, setIndustry] = useState(ANY);
  const [customer, setCustomer] = useState("");
  const [matchCount, setMatchCount] = useState("8");
  const [result, setResult] = useState<SearchLibraryResult | null>(null);

  const search = useMutation({
    mutationFn: async () =>
      searchLibrary({
        data: {
          query: query.trim(),
          industry: industry === ANY ? undefined : industry,
          customer: customer.trim() || undefined,
          matchCount: Number(matchCount),
        },
      }),
    onSuccess: setResult,
    onError: () => setResult({ ok: false, error: "Search failed. Please try again." }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    search.mutate();
  };

  const chunks: RetrievedChunk[] = result?.ok ? result.chunks : [];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-6">
        <div>
          <p className="mb-2 text-sm font-medium text-primary">Administration · temporary</p>
          <h1 className="text-3xl font-bold tracking-normal">Retrieval debug</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Runs the same hybrid search chat will use, as your signed-in session. Only files you are
            allowed to read can appear.
          </p>
        </div>
        <Link
          to="/admin"
          className="text-sm font-semibold text-primary underline underline-offset-4"
        >
          Admin dashboard ↗
        </Link>
      </div>

      <form onSubmit={submit} className="grid gap-4 border-b py-6 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2 lg:col-span-2">
          <Label htmlFor="rag-query">Question</Label>
          <Input
            id="rag-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. What is the United Next strategy?"
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <Label>Industry</Label>
          <Select value={industry} onValueChange={setIndustry}>
            <SelectTrigger aria-label="Filter industry" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All industries</SelectItem>
              <IndustryOptions />
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rag-customer">Customer (optional)</Label>
          <Input
            id="rag-customer"
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            placeholder="Exact customer name"
          />
        </div>
        <div className="space-y-2">
          <Label>Results</Label>
          <Select value={matchCount} onValueChange={setMatchCount}>
            <SelectTrigger aria-label="Result count" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["5", "8", "12", "20"].map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={search.isPending || query.trim().length < 2}>
            <Search /> {search.isPending ? "Searching…" : "Search"}
          </Button>
        </div>
      </form>

      {result && !result.ok && (
        <p role="alert" className="my-6 text-sm text-destructive">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <section className="py-6">
          <p className="text-sm text-muted-foreground">
            {chunks.length === 0
              ? "No passages matched."
              : `${chunks.length} passage(s) from ${new Set(chunks.map((c) => c.contentId)).size} file(s)`}
          </p>
          <ol className="mt-4 space-y-4">
            {chunks.map((chunk) => (
              <li key={chunk.chunkId} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-all font-semibold">{chunk.fileName}</p>
                  <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    score {chunk.score.toFixed(5)} · vector #{chunk.vectorRank ?? "–"} · text #
                    {chunk.textRank ?? "–"}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {chunk.title} · {chunk.industry}
                  {chunk.customerName ? ` · ${chunk.customerName}` : " · industry-wide"}
                  {chunk.page ? ` · page ${chunk.page}` : ""}
                  {chunk.slide ? ` · slide ${chunk.slide}` : ""}
                  {chunk.heading ? ` · ${chunk.heading}` : ""}
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm">{chunk.content.slice(0, 700)}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

function IndustryOptions() {
  const { industries } = Route.useLoaderData();
  return (
    <>
      {industries.map((industry) => (
        <SelectItem key={industry.slug} value={industry.slug}>
          {industry.name}
        </SelectItem>
      ))}
    </>
  );
}
