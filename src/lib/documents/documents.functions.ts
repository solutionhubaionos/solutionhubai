/**
 * Document generation endpoint. Runs only after the user confirms a draft: the
 * worker retrieves passages with the caller's JWT (so RLS still decides what
 * the document may contain), asks the model for an outline, then renders the
 * file in memory and returns it as base64.
 *
 * Renderers are imported dynamically so the client bundle never pulls in the
 * zip writer, and nothing is written to Storage or the library.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_MATCH_COUNT } from "../rag/config";
import { embedQuery } from "../rag/embeddings";
import { searchLibraryChunks, type RetrievedChunk } from "../rag/search";
import { composeDocument, fallbackOutline } from "./compose";
import { DOCUMENT_FORMATS, documentFileName, type GeneratedDocument } from "./types";

export type GenerateDocumentResult =
  | { ok: true; file: GeneratedDocument; sourceCount: number; usedFallback: boolean }
  | { ok: false; error: string };

const draftSchema = z.object({
  type: z.enum(["pdf", "docx", "pptx"]),
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

/** Search text for retrieval: the confirmed draft, not the raw chat message. */
function retrievalQuery(draft: z.infer<typeof draftSchema>): string {
  return [draft.title, draft.subtitle, draft.client, draft.industry, draft.sector, ...draft.outline]
    .filter((value): value is string => Boolean(value))
    .join(". ")
    .slice(0, 400);
}

async function passagesFor(
  supabase: Parameters<typeof searchLibraryChunks>[0],
  draft: z.infer<typeof draftSchema>,
  apiKey: string,
  baseUrl: string,
): Promise<RetrievedChunk[]> {
  try {
    return await searchLibraryChunks(
      supabase,
      retrievalQuery(draft),
      draft.industrySlug ? { industry: draft.industrySlug } : {},
      DEFAULT_MATCH_COUNT,
      (query) => embedQuery(query, { apiKey, baseUrl }),
    );
  } catch (error) {
    // A retrieval miss must not block the demo: the outline falls back to the
    // confirmed headings and says so in its warnings.
    console.error("[DOC] retrieval failed", error instanceof Error ? error.message : String(error));
    return [];
  }
}

export const generateDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ draft: draftSchema }).parse(data))
  .handler(async ({ data, context }): Promise<GenerateDocumentResult> => {
    const { draft } = data;
    const apiKey = process.env["TOKENFACTORY_API_KEY"];
    const baseUrl = process.env["TOKENFACTORY_API_BASE"];
    const providerReady = Boolean(apiKey && baseUrl);

    try {
      const passages = providerReady
        ? await passagesFor(context.supabase, draft, apiKey!, baseUrl!)
        : [];

      let usedFallback = true;
      let outline = fallbackOutline(draft, passages);
      if (providerReady) {
        try {
          const composed = await composeDocument(draft, passages, {
            apiKey: apiKey!,
            baseUrl: baseUrl!,
          });
          outline = composed.outline;
          usedFallback = false;
        } catch (error) {
          console.error(
            "[DOC] composition fell back",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      let bytes: Uint8Array;
      let pages: number;
      if (draft.type === "pdf") {
        const { renderPdf } = await import("./render/pdf");
        ({ bytes, pages } = renderPdf(outline));
      } else if (draft.type === "docx") {
        const { renderDocx } = await import("./render/docx");
        ({ bytes, pages } = renderDocx(outline));
      } else {
        const { renderPptx } = await import("./render/pptx");
        ({ bytes, pages } = renderPptx(outline));
      }

      const file: GeneratedDocument = {
        fileName: documentFileName(outline.title || draft.title, draft.type),
        mimeType: DOCUMENT_FORMATS[draft.type].mimeType,
        base64: Buffer.from(bytes).toString("base64"),
        bytes: bytes.byteLength,
        pages,
      };

      return { ok: true, file, sourceCount: passages.length, usedFallback };
    } catch (error) {
      console.error(
        "[DOC] generation failed",
        error instanceof Error ? error.message : String(error),
      );
      return { ok: false, error: "Could not build that document. Please try again." };
    }
  });
