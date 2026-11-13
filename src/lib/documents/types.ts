/** Shapes shared by the document generator, its renderers and the chat card. */

export type DocumentType = "pdf" | "docx" | "pptx";

/** Proposal = narrative document. Pitch = 8-12 takeaway-led slides. */
export type DocumentMode = "proposal" | "pitch";

export type DocumentFormat = {
  label: string;
  noun: string;
  extension: string;
  mimeType: string;
};

export const DOCUMENT_FORMATS: Record<DocumentType, DocumentFormat> = {
  pdf: { label: "PDF", noun: "proposal", extension: "pdf", mimeType: "application/pdf" },
  docx: {
    label: "Word document",
    noun: "proposal",
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pptx: {
    label: "PowerPoint deck",
    noun: "pitch deck",
    extension: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
};

/**
 * What the user confirms before a single byte is generated: the format, the
 * audience and the outline they are agreeing to.
 */
export type DocumentDraft = {
  type: DocumentType;
  /** Defaults to "pitch" for PPTX and "proposal" for PDF/DOCX. */
  mode: DocumentMode;
  title: string;
  subtitle: string;
  audience: string | null;
  industry: string | null;
  industrySlug: string | null;
  client: string | null;
  sector: string | null;
  outline: string[];
  /**
   * The confirmed slide plan (title + layout + section tag). When present it is
   * the contract: generation uses these titles and layouts verbatim.
   */
  outlinePlan?: SlidePlan[] | undefined;
  prompt: string;
  /**
   * Explicit consent to render only the sections that had evidence when the
   * quality gate blocks a full document. Never set by default.
   */
  allowPartial?: boolean | undefined;
};

/** Cover-page facts, kept even when a renderer wants to draw them differently. */
export type DocumentCover = {
  title: string;
  subtitle: string;
  client: string | null;
  industry: string | null;
  date: string;
  request: string;
};

/** One passage as it appears in the Sources section, with citation metadata. */
export type SourceRecord = {
  chunkId: string;
  contentId: string;
  title: string;
  fileName: string;
  filePath: string;
  industry: string;
  customerName: string | null;
  page: number | null;
  slide: number | null;
  heading: string | null;
  /** content_items.content_type, when the export could read the library row. */
  contentType?: string;
  /** content_items.created_at, when the export could read the library row. */
  date?: string;
};

export type SourceLabel = string;

/** One slide's composition. The model picks the layout that fits the content. */
export type SlideLayout =
  | "cover"
  | "summary"
  | "bullets"
  | "text"
  | "table"
  | "comparison"
  | "kpis"
  | "chart"
  | "flow"
  | "timeline"
  | "raci";

export type SlidePlan = {
  title: string;
  layout: SlideLayout;
  /** Optional section tag rendered in the slide header. */
  section?: string | undefined;
};

export type ChartType = "bar" | "stacked_bar" | "line" | "pie" | "doughnut";

export type ChartSpec = {
  type: ChartType;
  title: string;
  unit?: string;
  categories: string[];
  series: { name: string; values: number[] }[];
  /** sourced = values verbatim in cited passages; assumption = code model only. */
  basis: "sourced" | "assumption";
};

export type KpiItem = { label: string; value: string; note?: string; refs?: number[] };
export type FlowStep = { label: string; detail?: string };

type BlockBase = { sources: string[] };

export type TableBlock = {
  type: "table";
  caption?: string;
  headers: string[];
  rows: string[][];
  sources: string[];
};

export type MetricItem = {
  label: string;
  value: string;
  unit?: string;
  context?: string;
  source: string;
};

export type TimelineItem = {
  label: string;
  timeframe: string;
  detail: string;
  sources: string[];
};

export type ComparisonBlock = {
  type: "comparison";
  title?: string;
  criteria: string[];
  options: { name: string; values: string[] }[];
  sources: string[];
};

export type ListItem = { text: string; level?: number; sources?: string[] };

export type Block =
  | { type: "heading"; level: 2 | 3; text: string }
  | ({ type: "paragraph"; text: string } & BlockBase)
  | ({ type: "bullet_list"; items: ListItem[] } & BlockBase)
  | ({ type: "numbered_list"; items: ListItem[] } & BlockBase)
  | TableBlock
  | { type: "metrics"; items: MetricItem[]; sources: string[] }
  | ({ type: "callout"; tone: "info" | "warning" | "success"; text: string } & BlockBase)
  | { type: "quote"; text: string; attribution: string; source: string }
  | { type: "timeline"; items: TimelineItem[]; sources: string[] }
  | ComparisonBlock
  | { type: "chart"; chart: ChartSpec; caption?: string; sources: string[]; illustrative?: boolean }
  | { type: "kpis"; items: KpiItem[]; sources: string[] }
  | { type: "flow"; steps: FlowStep[]; sources: string[] };

export type DocumentSection = {
  /** Stable outline id, also used by the trace record. */
  id: string;
  kind: SectionKind;
  title: string;
  /** The composition the model chose for this slide. */
  layout?: SlideLayout;
  blocks: Block[];
  /** 2-4 sentences for PPTX speaker notes, with chunk references. */
  speakerNotes: string;
  /** Retrieval was too thin to write from; rendered with [To be confirmed]. */
  flagged: boolean;
  warnings: string[];
};

export type SectionKind =
  | "executive_summary"
  | "problem"
  | "solution"
  | "approach"
  | "proof"
  | "timeline"
  | "deliverables"
  | "assumptions"
  | "pricing"
  | "next_steps"
  | "why_us"
  | "how_it_works"
  | "results"
  | "ask"
  | "parties"
  | "pointers"
  | "shortcomings"
  | "economics"
  | "governance"
  | "open_questions"
  | "journey";

/** The validated JSON model every renderer consumes. No renderer has prose. */
export type DocumentModel = {
  mode: DocumentMode;
  format: DocumentType;
  cover: DocumentCover;
  sections: DocumentSection[];
  sources: SourceRecord[];
  openItems: string[];
  warnings: string[];
};

export type ExportBrief = {
  documentTitle: string;
  request: string;
  /** What the document is about, derived from the conversation, not the UI. */
  subject?: string | null;
  partiesInvolved?: string[];
  keyTopics?: string[];
  keyEntities?: string[];
  mode: DocumentMode;
  client: string | null;
  industry: string | null;
  sector: string | null;
  audience: string | null;
  problem: string | null;
  goals: string[];
  constraints: string[];
  budget: string | null;
  timeline: string | null;
  tone: string;
  include: string[];
  exclude: string[];
  decisions: string[];
  citedDocuments: { contentId: string | null; title: string }[];
  /** Figures the user asserted in chat; checked against sources, never trusted. */
  chatFigures: string[];
  openItems: string[];
};

export type DocumentTraceSection = {
  id: string;
  kind: SectionKind;
  title: string;
  query: string;
  chunkIds: string[];
  labels: string[];
  topScore: number | null;
  weak: boolean;
  warnings: string[];
};

/** Per-export audit record. Returned to the caller and logged, not persisted. */
export type DocumentTrace = {
  generatedAt: string;
  brief: ExportBrief;
  sections: DocumentTraceSection[];
  usedChunkIds: string[];
  openItems: string[];
  warnings: string[];
};

export type GeneratedDocument = {
  fileName: string;
  mimeType: string;
  base64: string;
  bytes: number;
  pages: number;
};

/** Why a section cannot ship, kept separate so the UI can say what happened. */
export type SectionFailure =
  "no_passages" | "provider_error" | "token_limit" | "timeout" | "schema_invalid";

export type DocumentGateSection = {
  id: string;
  title: string;
  passages: number;
  generated: boolean;
  /** Why the section cannot ship, or null when it can. */
  reason: SectionFailure | null;
  /** The raw error or retrieval note behind `reason`, for the trace and the UI. */
  detail: string | null;
};

/** Pre-render quality gate: a thin document is refused, never padded. */
export type DocumentGate = {
  coverage: number;
  blocked: boolean;
  sections: DocumentGateSection[];
  message: string;
};

export type DocumentBuildResult = {
  model: DocumentModel;
  trace: DocumentTrace;
  usedFallback: boolean;
  gate: DocumentGate;
};

export type DocumentDraftStatus = "proposed" | "generating" | "ready" | "cancelled" | "error";

/** One draft as it appears in the transcript, including its outcome. */
export type DocumentDraftState = {
  draft: DocumentDraft;
  status: DocumentDraftStatus;
  /** Set while the LLM outline for the confirm card is being planned. */
  planning?: boolean;
  error?: string | null;
  file?: GeneratedDocument | null;
  sourceCount?: number;
  openItems?: string[];
  warnings?: string[];
  trace?: DocumentTrace | null;
};

/** Safe download name: lower-case words joined by single hyphens. */
export function documentFileName(title: string, type: DocumentType): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "solution-hub-document";
  return `${base}.${DOCUMENT_FORMATS[type].extension}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
