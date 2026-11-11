/**
 * Assistant answer renderer: GitHub-flavored Markdown, sanitized, with [n]
 * markers turned into superscript links to the source chips below the answer.
 *
 * Memoised because the transcript re-renders on every keystroke in the
 * composer; the answer text only changes when a new turn arrives, so this
 * avoids re-parsing (and any flicker) while the user types.
 */
import { memo, useMemo, type ComponentProps } from "react";
import type { PluggableList } from "unified";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ChatSource } from "@/lib/chat/answer";
import { remarkCitations } from "./remarkCitations";
import { FOCUS } from "./theme";

/** Default schema plus the one custom attribute our citation links need. */
export const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "sup"],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.["a"] ?? []), ["className", "citation-chip"], ["aria-label"]],
  },
};

const components = {
  h1: ({ children }: ComponentProps<"h1">) => (
    <h2 className="mt-5 mb-2 font-display text-base font-semibold text-foreground">{children}</h2>
  ),
  h2: ({ children }: ComponentProps<"h2">) => (
    <h2 className="mt-5 mb-2 font-display text-base font-semibold text-foreground">{children}</h2>
  ),
  h3: ({ children }: ComponentProps<"h3">) => (
    <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground">{children}</h3>
  ),
  h4: ({ children }: ComponentProps<"h4">) => (
    <h4 className="mt-3 mb-1 text-sm font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }: ComponentProps<"p">) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }: ComponentProps<"ul">) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-primary">{children}</ul>
  ),
  ol: ({ children }: ComponentProps<"ol">) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:font-semibold marker:text-primary">
      {children}
    </ol>
  ),
  li: ({ children }: ComponentProps<"li">) => <li className="pl-0.5 [&>p]:my-0.5">{children}</li>,
  table: ({ children }: ComponentProps<"table">) => (
    <div className="my-3 w-full overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[420px] border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: ComponentProps<"thead">) => (
    <thead className="bg-secondary/70 text-left">{children}</thead>
  ),
  tbody: ({ children }: ComponentProps<"tbody">) => (
    <tbody className="[&>tr:nth-child(even)]:bg-secondary/30">{children}</tbody>
  ),
  tr: ({ children }: ComponentProps<"tr">) => (
    <tr className="border-b border-border last:border-b-0">{children}</tr>
  ),
  th: ({ children }: ComponentProps<"th">) => (
    <th className="px-2.5 py-2 font-semibold whitespace-normal text-foreground">{children}</th>
  ),
  td: ({ children }: ComponentProps<"td">) => (
    <td className="px-2.5 py-2 align-top text-foreground/90">{children}</td>
  ),
  blockquote: ({ children }: ComponentProps<"blockquote">) => (
    <blockquote className="my-3 border-l-2 border-primary/50 bg-secondary/30 py-1 pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }: ComponentProps<"code">) =>
    className?.startsWith("language-") ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    ),
  pre: ({ children }: ComponentProps<"pre">) => (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-secondary/60 p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }: ComponentProps<"strong">) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  a: (input: ComponentProps<"a">) => {
    const {
      children,
      href,
      className: _className,
      node: _node,
      ...props
    } = input as ComponentProps<"a"> & { node?: unknown };
    if (typeof href === "string" && href.startsWith("#source-")) {
      return (
        <sup className="mx-0.5">
          <a
            href={href}
            className={`citation-chip ${FOCUS} rounded bg-primary/10 px-1 py-0.5 text-[10px] font-semibold text-primary no-underline transition-colors hover:bg-primary/20`}
            {...props}
          >
            {children}
          </a>
        </sup>
      );
    }
    return (
      <a
        href={href}
        className="font-medium text-primary underline underline-offset-2"
        target="_blank"
        rel="noreferrer noopener"
        {...props}
      >
        {children}
      </a>
    );
  },
};

export const MarkdownAnswer = memo(function MarkdownAnswer({
  text,
  sources,
  anchorPrefix,
}: {
  text: string;
  sources: ChatSource[];
  anchorPrefix: string;
}) {
  const known = useMemo(() => new Set(sources.map((source) => source.citation)), [sources]);
  const plugins = useMemo<PluggableList>(
    () => [remarkGfm, [remarkCitations, { known, anchorPrefix }]],
    [known, anchorPrefix],
  );

  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
