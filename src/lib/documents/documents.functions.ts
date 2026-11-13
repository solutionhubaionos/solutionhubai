/**
 * Document generation endpoint. Runs only after the user confirms a draft: the
 * worker builds a brief from the whole conversation, retrieves per section with
 * the caller's JWT (RLS still decides what the document may contain), validates
 * the structured output, then renders the file in memory as base64.
 *
 * Renderers are imported dynamically so the client bundle never pulls in the
 * zip or PDF writers, and nothing is written to Storage or the library.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildDocument } from "./build";
import { buildExportBrief } from "./brief";
import { buildDraft } from "./intent";
import { planOutline } from "./outline";
import {
  DOCUMENT_FORMATS,
  documentFileName,
  type DocumentDraft,
  type GeneratedDocument,
  type DocumentTrace,
  type SlidePlan,
} from "./types";

export type GenerateDocumentResult =
  | {
      ok: true;
      file: GeneratedDocument;
      sourceCount: number;
      usedFallback: boolean;
      openItems: string[];
      warnings: string[];
      trace: DocumentTrace;
    }
  | {
      ok: false;
      error: string;
      /** Sections the gate refused; the UI can offer a partial document. */
      missingSections?: { id: string; title: string; passages: number; reason: string | null }[];
      canGeneratePartial?: boolean;
    };

const historySchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().trim().min(1).max(6000),
      sources: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(200),
            contentId: z.string().uuid().nullish(),
            chunkId: z.string().uuid().nullish(),
          }),
        )
        .max(12)
        .optional(),
    }),
  )
  .max(40)
  .optional();

const slidePlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  layout: z.enum([
    "summary",
    "bullets",
    "text",
    "table",
    "comparison",
    "kpis",
    "chart",
    "flow",
    "timeline",
    "raci",
  ]),
  section: z.string().trim().max(40).optional(),
});

const draftSchema = z.object({
  type: z.enum(["pdf", "docx", "pptx"]),
  mode: z.enum(["proposal", "pitch"]),
  title: z.string().trim().min(3).max(120),
  subtitle: z.string().trim().max(200),
  audience: z.string().trim().max(80).nullable(),
  industry: z.string().trim().max(80).nullable(),
  industrySlug: z.string().trim().max(64).nullable(),
  client: z.string().trim().max(120).nullable(),
  sector: z.string().trim().max(80).nullable(),
  outline: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
  outlinePlan: z.array(slidePlanSchema).max(12).optional(),
  prompt: z.string().trim().max(500),
  allowPartial: z.boolean().optional(),
});

const planContextSchema = z.object({
  clients: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  personas: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  industries: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  sectors: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  website: z.string().trim().max(200).default(""),
});

export type PlanDocumentResult =
  | {
      ok: true;
      /** Title derived from the conversation, for the confirm card. */
      title: string;
      subtitle: string;
      subject: string | null;
      parties: string[];
      /** Eight to twelve takeaway headings, in order, used verbatim at build time. */
      outline: string[];
      /** Title + layout + section tag agreed on the confirm card. */
      outlinePlan: SlidePlan[];
      usedFallback: boolean;
    }
  | { ok: false; error: string };

/**
 * Plans the outline the user sees on the confirm card. It reads the whole
 * conversation through the same brief builder the export uses, asks the model
 * for takeaway headings tailored to the named parties, and falls back to the
 * mode's standard structure only when planning fails. The returned list is what
 * `generateDocument` later treats as the confirmed outline.
 */
export const planDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        prompt: z.string().trim().min(2).max(2000),
        type: z.enum(["pdf", "docx", "pptx"]),
        mode: z.enum(["proposal", "pitch"]),
        context: planContextSchema.optional(),
        industryNames: z.record(z.string()).optional(),
        history: historySchema,
      })
      .parse(data),
  )
  .handler(async ({ data, context: requestContext }): Promise<PlanDocumentResult> => {
    const apiKey = process.env["TOKENFACTORY_API_KEY"];
    const baseUrl = process.env["TOKENFACTORY_API_BASE"];
    if (!apiKey || !baseUrl) {
      return { ok: false, error: "Document planning needs the AI provider configured." };
    }

    const context = {
      clients: data.context?.clients ?? [],
      personas: data.context?.personas ?? [],
      industries: data.context?.industries ?? [],
      sectors: data.context?.sectors ?? [],
      website: data.context?.website ?? "",
    };

    try {
      const draft: DocumentDraft = {
        ...buildDraft({
          prompt: data.prompt,
          type: data.type,
          context,
          ...(data.industryNames ? { industryNames: data.industryNames } : {}),
        }),
        mode: data.mode,
      };
      const brief = await buildExportBrief(draft, data.history ?? [], {
        apiKey,
        baseUrl,
        client: requestContext.supabase,
        log: (event, meta) => console.log(`[DOC] plan ${event}`, meta),
      });
      const planned = await planOutline(brief, draft, {
        apiKey,
        baseUrl,
        log: (event, meta) => console.log(`[DOC] plan ${event}`, meta),
      });

      return {
        ok: true,
        title: brief.documentTitle || draft.title,
        subtitle: draft.subtitle,
        subject: brief.subject ?? null,
        parties: [
          ...new Set([...(brief.partiesInvolved ?? []), ...(brief.keyEntities ?? [])]),
        ].slice(0, 8),
        outline: planned.plans.map((plan) => plan.title),
        outlinePlan: planned.plans.map((plan) => ({
          title: plan.title,
          layout: plan.layout ?? "bullets",
          ...(plan.section ? { section: plan.section } : {}),
        })),
        usedFallback: planned.usedFallback,
      };
    } catch (error) {
      console.error(
        "[DOC] planning failed",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return { ok: false, error: "Could not plan that document. Please try again." };
    }
  });

export const generateDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ draft: draftSchema, history: historySchema }).parse(data),
  )
  .handler(async ({ data, context }): Promise<GenerateDocumentResult> => {
    const { draft } = data;
    const history = data.history ?? [];
    const apiKey = process.env["TOKENFACTORY_API_KEY"];
    const baseUrl = process.env["TOKENFACTORY_API_BASE"];
    if (!apiKey || !baseUrl) {
      console.error("[DOC] Provider credentials are not configured");
      return { ok: false, error: "Document generation needs the AI provider configured." };
    }

    try {
      const built = await buildDocument({
        draft,
        history,
        client: context.supabase,
        provider: { apiKey, baseUrl },
        log: (event, meta) => console.log(`[DOC] ${event}`, meta),
      });

      // Quality gate: never write a placeholder-filled file. The caller gets
      // the exact sections that lacked evidence so it can offer a partial deck.
      if (built.gate.blocked) {
        console.log("[DOC] quality gate blocked", {
          coverage: built.gate.coverage,
          sections: built.gate.sections.map((section) => ({
            title: section.title,
            passages: section.passages,
            generated: section.generated,
            reason: section.reason,
          })),
        });
        return {
          ok: false,
          error: built.gate.message,
          missingSections: built.gate.sections.filter((section) => section.reason !== null),
          canGeneratePartial: true,
        };
      }

      let bytes: Uint8Array;
      let pages: number;
      if (draft.type === "pdf") {
        const { renderPdf } = await import("./render/pdf");
        ({ bytes, pages } = await renderPdf(built.model));
      } else if (draft.type === "docx") {
        const { renderDocx } = await import("./render/docx");
        ({ bytes, pages } = renderDocx(built.model));
      } else {
        const { renderPptx } = await import("./render/pptx");
        ({ bytes, pages } = renderPptx(built.model));
      }

      const file: GeneratedDocument = {
        fileName: documentFileName(built.model.cover.title || draft.title, draft.type),
        mimeType: DOCUMENT_FORMATS[draft.type].mimeType,
        base64: Buffer.from(bytes).toString("base64"),
        bytes: bytes.byteLength,
        pages,
      };

      console.log("[DOC] trace", {
        brief: built.trace.brief,
        sections: built.trace.sections.map((section) => ({
          id: section.id,
          query: section.query,
          chunks: section.chunkIds.length,
          weak: section.weak,
        })),
      });

      return {
        ok: true,
        file,
        sourceCount: built.model.sources.length,
        usedFallback: built.usedFallback,
        openItems: built.model.openItems,
        warnings: built.model.warnings,
        trace: built.trace,
      };
    } catch (error) {
      console.error(
        "[DOC] generation failed",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return { ok: false, error: "Could not build that document. Please try again." };
    }
  });
