/** Shapes shared by the document generator, its renderers and the chat card. */

export type DocumentType = "pdf" | "docx" | "pptx";

export type DocumentFormat = {
  label: string;
  noun: string;
  extension: string;
  mimeType: string;
};

export const DOCUMENT_FORMATS: Record<DocumentType, DocumentFormat> = {
  pdf: { label: "PDF", noun: "one-pager", extension: "pdf", mimeType: "application/pdf" },
  docx: {
    label: "Word document",
    noun: "brief",
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
  title: string;
  subtitle: string;
  audience: string | null;
  industry: string | null;
  industrySlug: string | null;
  client: string | null;
  sector: string | null;
  outline: string[];
  prompt: string;
};

export type DocumentOutlineSection = { heading: string; bullets: string[] };

export type DocumentOutline = {
  title: string;
  subtitle: string;
  sections: DocumentOutlineSection[];
};

export type GeneratedDocument = {
  fileName: string;
  mimeType: string;
  base64: string;
  bytes: number;
  pages: number;
};

export type DocumentDraftStatus = "proposed" | "generating" | "ready" | "cancelled" | "error";

/** One draft as it appears in the transcript, including its outcome. */
export type DocumentDraftState = {
  draft: DocumentDraft;
  status: DocumentDraftStatus;
  error?: string | null;
  file?: GeneratedDocument | null;
  sourceCount?: number;
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
