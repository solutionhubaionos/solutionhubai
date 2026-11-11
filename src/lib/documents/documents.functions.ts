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
import {
  DOCUMENT_FORMATS,
  documentFileName,
  type GeneratedDocument,
  type DocumentTrace,
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
  | { ok: false; error: string };

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
  outline: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  prompt: z.string().trim().max(500),
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
