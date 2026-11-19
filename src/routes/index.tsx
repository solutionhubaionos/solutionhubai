import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, FileText, Presentation, PlayCircle, FileSignature } from "lucide-react";
import hero from "@/assets/hero.webp";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useIndustries } from "@/lib/industries";

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "preload", as: "image", href: hero, fetchPriority: "high" }],
    meta: [
      { title: "Solution Hub — Sales & Pre-sales Enablement" },
      {
        name: "description",
        content:
          "Case studies, pitch decks, POC videos and proposals organized by industry and customer.",
      },
      { property: "og:title", content: "Solution Hub — Sales & Pre-sales Enablement" },
      {
        property: "og:description",
        content:
          "Case studies, pitch decks, POC videos and proposals organized by industry and customer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const KINDS = [
  { icon: FileText, label: "Customer case studies" },
  { icon: Presentation, label: "Solution pitch decks" },
  { icon: PlayCircle, label: "Actual POC videos" },
  { icon: FileSignature, label: "Proposals" },
];

function Index() {
  const { industries: INDUSTRIES } = useIndustries();
  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden bg-ink">
        <img
          src={hero}
          alt=""
          width={1600}
          height={912}
          fetchPriority="high"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="relative mx-auto max-w-7xl px-6">
          <header className="flex items-center justify-between py-6">
            <Logo inverted />
            <Button asChild variant="glass">
              <Link to="/auth">Sign in</Link>
            </Button>
          </header>
          <div className="max-w-2xl pb-28 pt-20 md:pt-32">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Sales enablement
            </p>
            <h1 className="mt-4 text-4xl font-bold leading-tight text-ink-foreground md:text-6xl">
              Every winning story, one place.
            </h1>
            <p className="mt-6 text-lg text-ink-foreground/80">
              Find the right case study, deck, POC video or proposal for your next prospect —
              organized by industry and customer.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild variant="accent" size="lg">
                <Link to="/auth">
                  Get started <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="relative z-10 mx-auto -mt-10 max-w-7xl px-6">
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-card p-4 shadow-card md:grid-cols-4">
          {KINDS.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-3 rounded-xl p-3">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-secondary text-primary">
                <Icon className="h-5 w-5" />
              </span>
              <span className="text-sm font-semibold">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-20">
        <h2 className="text-3xl font-bold">Browse by industry</h2>
        <p className="mt-2 text-muted-foreground">
          Industry playbooks plus customer-specific material.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {INDUSTRIES.map((i) => (
            <Link
              key={i.slug}
              to="/industry/$slug"
              params={{ slug: i.slug }}
              className="group relative aspect-[4/5] overflow-hidden rounded-2xl shadow-card"
            >
              <img
                src={i.image}
                alt={i.name}
                loading="lazy"
                width={1200}
                height={800}
                className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-ink" />
              <div className="absolute bottom-0 p-5">
                <h3 className="text-xl font-semibold text-ink-foreground">{i.name}</h3>
                <p className="mt-1 text-sm text-ink-foreground/75">{i.tagline}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        Solution Hub · Internal use only
      </footer>
    </div>
  );
}
