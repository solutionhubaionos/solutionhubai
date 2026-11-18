/**
 * Export orchestrator: brief from the conversation, the confirmed slide plan as
 * the contract, one evidence pass shared by every slide, ONE deck call, ONE
 * verification call, then a gate that refuses only a document with no evidence
 * or fewer than four usable slides.
 *
 * The trace records what the brief said, the queries the evidence pass used and
 * the chunk ids behind each slide, so every claim can be audited.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import { embedQuery } from "../rag/embeddings";
import { loadValidatedEntities } from "../rag/entities";
import { ANONYMISE_REFERENCES } from "../rag/config";
import { loadReferenceRedactor } from "./references";
import type { ReferenceRedactor } from "./redact";
import type { RetrievedChunk } from "../rag/search";
import { buildExportBrief, resolveConversationParties, type ExportHistoryMessage } from "./brief";
import { scopeCompanyNames, type ConversationScope } from "../chat/conversationScope";
import { buildDeck } from "./deck/build";
import {
  groundedEntities,
  normaliseEntityName,
  partyList,
  retrievalEntityNames,
} from "./deck/entities";
import { loadClaims } from "./deck/claims";
import { chunkIdsForClaims } from "./deck/evidence";
import { factsForParties } from "./deck/enrichment";
import { verifyDeckClaims } from "./verify";
import { gatherDeckEvidence, topUpDeckEvidence } from "./retrieval";
import { deckAnalysisContext, generateDeck } from "./deck";
import { normalizeDeck, fallbackSlide, thinSlides } from "./slides";
import { mustIncludeItems, plansFromOutline, type SectionPlan } from "./outline";
import { sectionSourceIds } from "./generate";
import { sourceRecords, validateModel } from "./validate";
import { failureReasonOf } from "./provider";
import { coverDate } from "./theme";
import type {
  Block,
  DocumentBuildResult,
  SectionFailure,
  DocumentDraft,
  DocumentGate,
  DocumentModel,
  DocumentSection,
  DocumentTraceSection,
  SourceRecord,
} from "./types";

export type BuildDocumentInput = {
  draft: DocumentDraft;
  history: readonly ExportHistoryMessage[];
  client: SupabaseClient<Database>;
  provider: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch };
  /** The conversation's stored scope; every company and sector in it ships. */
  scope?: ConversationScope;
  /** Industry slug -> display name for the scope's sectors. */
  industryNames?: Record<string, string>;
  now?: Date;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * Maps a raw failure to the one reason the gate and the UI report. Provider
 * errors and schema errors used to collapse into "generation did not produce
 * usable content", which told the user nothing actionable.
 */
export function classifySectionFailure(error: unknown): SectionFailure {
  return failureReasonOf(error);
}

/** Metadata for the Sources section; best-effort, RLS still applies. */
async function enrichSources(
  client: SupabaseClient<Database>,
  records: SourceRecord[],
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<SourceRecord[]> {
  const contentIds = [...new Set(records.map((record) => record.contentId))];
  if (contentIds.length === 0) return records;
  try {
    const { data, error } = await client
      .from("content_items")
      .select("id, content_type, created_at")
      .in("id", contentIds);
    if (error || !data) throw error ?? new Error("no content rows returned");
    const rows = data as { id: string; content_type: string; created_at: string }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return records.map((record) => {
      const row = byId.get(record.contentId);
      if (!row) return record;
      return {
        ...record,
        contentType: row.content_type,
        date: row.created_at.slice(0, 10),
      };
    });
  } catch (error) {
    log("source metadata unavailable", { error: String(error) });
    return records;
  }
}

/** Recursively rewrites every string in a prompt object; keys stay unchanged. */
function scrubPromptValue<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((entry) => scrubPromptValue(entry, scrub)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        scrubPromptValue(child, scrub),
      ]),
    ) as T;
  }
  return value;
}

function redactClaims(
  claims: Awaited<ReturnType<typeof loadClaims>>,
  redactor: ReferenceRedactor,
): Awaited<ReturnType<typeof loadClaims>> {
  return Object.fromEntries(
    Object.entries(claims).map(([id, claim]) => [id, scrubPromptValue(claim, redactor.scrub)]),
  );
}

function toSourceRecord(chunk: RetrievedChunk): SourceRecord {
  return {
    chunkId: chunk.chunkId,
    contentId: chunk.contentId,
    title: chunk.title,
    fileName: chunk.fileName,
    filePath: chunk.filePath,
    industry: chunk.industry,
    customerName: chunk.customerName,
    page: chunk.page,
    slide: chunk.slide,
    heading: chunk.heading,
  };
}

/** The client this document is addressed to, if the conversation named one. */
function targetNameFor(
  scope: ConversationScope | undefined,
  brief: { client?: string | null },
  draft: { client?: string | null },
): string | null {
  return (
    scope?.targetClients[0]?.name?.trim() || brief.client?.trim() || draft.client?.trim() || null
  );
}

/**
 * Deck gate: only zero evidence or fewer than four usable slides blocks. A
 * missing or thin slide becomes an Open item, never a reason to refuse the file.
 */
function deckGateFor(
  plans: readonly SectionPlan[],
  sections: readonly DocumentSection[],
  chunks: readonly RetrievedChunk[],
): DocumentGate {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const gateSections = plans.map((plan) => {
    const section = byId.get(plan.id);
    const passages = section ? sectionSourceIds(section).length : 0;
    const generated = Boolean(section && section.blocks.some((block) => block.type !== "heading"));
    const illustrative = Boolean(
      section?.blocks.some((block) => block.type === "chart" && block.illustrative),
    );
    const reason: SectionFailure | null =
      chunks.length === 0
        ? "no_passages"
        : !section
          ? "schema_invalid"
          : passages === 0 && !illustrative
            ? "no_passages"
            : null;
    return {
      id: plan.id,
      title: section?.title ?? plan.title,
      passages,
      generated,
      reason,
      detail: !section ? "The deck returned no content for this slide." : null,
    };
  });
  const usable = sections.filter((section) =>
    section.blocks.some((block) => block.type !== "heading"),
  );
  const blocked = chunks.length === 0 || usable.length < 4;
  return {
    coverage: plans.length > 0 ? usable.length / plans.length : 0,
    blocked,
    sections: gateSections,
    message:
      chunks.length === 0
        ? "No library passages were found for this request. Widen the industry, or describe the problem you want to lead with: the deck is built from other customers' work, never from the target client's own material."
        : blocked
          ? `Only ${usable.length} usable slides survived; at least four are needed to write this document.`
          : "",
  };
}

export async function buildDocument(input: BuildDocumentInput): Promise<DocumentBuildResult> {
  const log = input.log ?? (() => undefined);
  const now = input.now ?? new Date();
  const brief = await buildExportBrief(input.draft, input.history, {
    ...input.provider,
    client: input.client,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.industryNames ? { industryNames: input.industryNames } : {}),
    log,
  });
  const targetName = targetNameFor(input.scope, brief, input.draft);
  const clientLogo = input.scope?.targetClients[0]?.logo ?? null;
  log("export target", { target: targetName, logo: Boolean(clientLogo) });

  // The confirmed outline is the plan. Nothing regenerates, reorders or pads it
  // at build time; titles, order and layouts were fixed on the confirm screen.
  const plans = plansFromOutline(input.draft, brief);

  // Entities are the union of the brief, the conversation resolver and the
  // wizard selection, so a party the brief missed still gets its own search.
  const conversationParties = await resolveConversationParties(
    input.client,
    input.history,
    input.draft,
  ).catch(() => []);

  // A brief can name an organisation the user never mentioned (an adjacent
  // company or a guess). Those names must not drive retrieval: they would pull
  // another customer's passages into this deck. Keep a key entity only when the
  // user's own words contain it.
  const requestText = normaliseEntityName(
    [
      input.draft.prompt,
      input.draft.title,
      ...input.history
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ].join(" "),
  );
  const mentionedInRequest = (name: string) => {
    const key = normaliseEntityName(name);
    return key.length >= 3 && requestText.includes(key);
  };
  const wizardCompanies = input.scope ? scopeCompanyNames(input.scope) : [];
  // The client we are pitching is never an evidence customer. Its name must not
  // reach entity resolution, or the deck is searched against a customer the
  // library does not have and every section comes back empty.
  const targetKeys = (input.scope?.targetClients ?? [])
    .map((client) => normaliseEntityName(client.name))
    .filter(Boolean);
  const isTarget = (name: string) => {
    const key = normaliseEntityName(name);
    if (!key) return false;
    return targetKeys.some(
      (target) => key === target || key.includes(target) || target.includes(key),
    );
  };
  const briefEntities = (brief.keyEntities ?? [])
    .filter(mentionedInRequest)
    .filter((name) => !isTarget(name));

  // Validate before retrieval, so the searched names are the canonical ones.
  // PDF/DOCX still run the legacy section pipeline and keep the plain union.
  const partyCandidates = [
    ...new Set([
      ...wizardCompanies,
      ...(input.draft.client ? [input.draft.client] : []),
      ...(brief.partiesInvolved ?? []),
      ...briefEntities,
      ...conversationParties,
    ]),
  ]
    .filter((name) => !isTarget(name))
    .slice(0, 12);
  const lookup =
    input.draft.type === "pptx"
      ? await loadValidatedEntities(input.client, partyCandidates, { limit: 12, threshold: 0.42 })
      : { available: false, entities: [] };

  // `match_entities` is a trigram search, so near neighbours come back too:
  // asking about "Adani Airports" can also return "Zurich Airport" and "Adani
  // Power", and the brief may list those neighbours itself (a score cannot tell
  // them apart, because an exact brief string scores 1.0). A row is a party of
  // THIS document only when the user's own words name it, or the wizard or the
  // client field does. Aliases keep a misspelt request working: the matched
  // spelling is part of `spellings`.
  const validatedEntities = groundedEntities({
    entities: lookup.entities,
    requestText,
    wizardCompanies,
    clientName: input.draft.client,
  });

  const entityNames =
    input.draft.type === "pptx"
      ? retrievalEntityNames({
          wizardCompanies,
          clientName: input.draft.client,
          briefParties: brief.partiesInvolved ?? [],
          briefEntities,
          conversationEntities: conversationParties,
          validatedEntities,
          authoritative: lookup.available,
        })
      : [...new Set(partyCandidates.map((name) => name.trim()).filter(Boolean))];
  log("export entities union", { entities: entityNames });

  const evidence = await gatherDeckEvidence({
    client: input.client,
    brief,
    plans,
    entityNames,
    targetName,
    industrySlug: input.draft.industrySlug,
    history: input.history,
    embed: (query) => embedQuery(query, input.provider),
    log,
  });

  const chunksById = new Map<string, string>();
  const chunkMeta = new Map<string, SourceRecord>();
  for (const chunk of evidence.chunks) {
    chunksById.set(chunk.chunkId, chunk.content);
    chunkMeta.set(chunk.chunkId, toSourceRecord(chunk));
  }

  // Decks run through the planner → writer → critic pipeline. PDF/DOCX keep the
  // legacy section pipeline until the proposal planner is moved over.
  if (input.draft.type === "pptx") {
    // No evidence at all means no deck: the writer would only be inventing.
    if (evidence.chunks.length === 0) {
      const message =
        "No library passages were found for this request. Widen the industry, or describe the problem you want to lead with: the deck is built from other customers' work, never from the target client's own material.";
      return {
        model: {
          mode: input.draft.mode,
          format: input.draft.type,
          cover: {
            title: brief.documentTitle || input.draft.title,
            subtitle: input.draft.subtitle,
            client: brief.client,
            industry: brief.industry,
            date: coverDate(now),
            request: brief.request || input.draft.prompt,
          },
          sections: [],
          sources: [],
          openItems: brief.openItems,
          warnings: [...new Set([...evidence.warnings, message])],
        },
        trace: {
          generatedAt: now.toISOString(),
          brief,
          sections: [],
          usedChunkIds: [],
          openItems: brief.openItems,
          warnings: [...new Set([message])],
          retrieval: {
            target: evidence.target.name,
            targetPassages: evidence.target.passages,
            peerPassages: evidence.target.peers,
          },
        },
        usedFallback: false,
        gate: {
          coverage: 0,
          blocked: true,
          sections: [],
          message,
        },
      };
    }

    // The deck is written TO the pitched client; library customers are
    // references, never parties. Co-pitch targets stay parties because the
    // conversation explicitly named them.
    const targetParties = (input.scope?.targetClients ?? [])
      .map((client) => client.name.trim())
      .filter(Boolean);
    const parties =
      targetParties.length > 0
        ? targetParties
        : targetName
          ? [targetName]
          : partyList({
              wizardCompanies,
              clientName: input.draft.client,
              briefParties: brief.partiesInvolved ?? [],
              briefEntities,
              conversationEntities: conversationParties,
              evidenceNames: evidence.chunks
                .map((chunk) => chunk.customerName)
                .filter((name): name is string => Boolean(name)),
              validatedEntities,
              authoritative: lookup.available,
            });
    log("deck entities validated", {
      resolved: validatedEntities.map((entity) => `${entity.name} (${entity.type})`),
    });
    log("deck parties validated", {
      parties,
      entities: entityNames,
      target: evidence.target.name,
      targetPassages: evidence.target.passages,
      peerPassages: evidence.target.peers,
    });

    const claims = await loadClaims(input.client, evidence.chunks, log);
    // Gap parties get sourced facts when we have them (curated today; the
    // provider seam is empty, so an uncovered party stays honestly inferred).
    const facts = await factsForParties(input.client, parties, log);

    // The model never sees a reference customer's name, document title or file
    // name. The raw chunks remain in `chunkMeta` for the author-facing trace.
    const shouldAnonymise =
      ANONYMISE_REFERENCES &&
      targetParties.length > 0 &&
      (input.scope?.targetClients[0]?.anonymise ?? brief.anonymise ?? true);
    const redactor = shouldAnonymise
      ? await loadReferenceRedactor(
          input.client,
          evidence.chunks,
          [...targetParties, ...(targetName ? [targetName] : [])],
          log,
        )
      : null;
    const modelChunks = redactor ? evidence.chunks.map(redactor.scrubChunk) : evidence.chunks;
    const modelClaims = redactor ? redactClaims(claims, redactor) : claims;
    const modelBrief = redactor ? scrubPromptValue(brief, redactor.scrub) : brief;
    const built = await buildDeck({
      brief: modelBrief,
      draft: input.draft,
      parties,
      chunks: modelChunks,
      claims: modelClaims,
      groups: evidence.groups.map((group) => ({
        name: group.name,
        matchedName: group.matchedName,
        chunkIds: group.chunks.map((chunk) => chunk.chunkId),
        gap: group.gap,
      })),
      ...(Object.keys(facts).length > 0 ? { facts } : {}),
      provider: { ...input.provider, log },
      ...(targetName ? { targetClient: targetName } : {}),
      ...(redactor
        ? {
            scrubText: redactor.scrub,
            blocklist: redactor.entries.map((entry) => entry.value),
          }
        : {}),
      log,
    });

    const usedChunkIds = [
      ...new Set([
        ...built.spec.slides.flatMap((slide) =>
          chunkIdsForClaims(slide.claimIds, built.spec.claims),
        ),
        // Slides also carry the passages they were written from. Without them
        // the Sources list omits evidence that the deck actually cites.
        ...built.sections.flatMap((section) => section.evidenceIds ?? []),
      ]),
    ];
    const records = usedChunkIds
      .map((id) => chunkMeta.get(id))
      .filter((record): record is SourceRecord => Boolean(record));
    const sources = await enrichSources(input.client, records, log);

    const gateSections = built.spec.slides.map((slide) => {
      const passages = chunkIdsForClaims(slide.claimIds, built.spec.claims).length;
      return {
        id: slide.id,
        title: slide.actionTitle,
        passages,
        generated: true,
        reason: evidence.chunks.length === 0 ? ("no_passages" as const) : null,
        detail: passages === 0 ? "No passage supports this slide; its tier is proposed." : null,
      };
    });
    const blocked = evidence.chunks.length === 0 || built.spec.slides.length === 0;
    const gate: DocumentGate = {
      coverage:
        built.spec.slides.length > 0
          ? built.spec.slides.filter((slide) => slide.tier === "sourced").length /
            built.spec.slides.length
          : 0,
      blocked,
      sections: gateSections,
      message:
        evidence.chunks.length === 0
          ? "No library passages were found for this request, so no document was written."
          : blocked
            ? "The deck pipeline produced no usable slides."
            : "",
    };

    const openItems = [...new Set([...modelBrief.openItems, ...built.openItems])]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    const warnings = [
      ...new Set([
        ...evidence.warnings,
        ...built.warnings,
        ...(blocked ? [gate.message] : []),
      ]),
    ];

    const model: DocumentModel = {
      mode: input.draft.mode,
      format: input.draft.type,
      cover: {
        title: modelBrief.documentTitle || input.draft.title,
        subtitle: input.draft.subtitle,
        client: modelBrief.client,
        industry: modelBrief.industry,
        date: coverDate(now),
        request: modelBrief.request || input.draft.prompt,
      },
      sections: built.sections,
      sources,
      openItems,
      warnings,
      deck: built.spec,
      clientLogo,
    };

    const final = validateModel(model, chunksById);
    if (final.errors.length > 0) {
      log("deck validation warnings", { errors: final.errors.slice(0, 8) });
      model.warnings = [...model.warnings, ...final.errors.map((error) => `Validation: ${error}`)];
    }
    model.warnings = [...new Set([...model.warnings, ...final.warnings])];

    const traceSections: DocumentTraceSection[] = built.sections.map((section, index) => ({
      id: section.id,
      kind: section.kind,
      title: section.title,
      query: evidence.queries.join(" | "),
      chunkIds: built.spec.slides[index]
        ? [
            ...new Set([
              ...chunkIdsForClaims(built.spec.slides[index]!.claimIds, built.spec.claims),
              ...(built.spec.slides[index]!.evidenceIds ?? []),
            ]),
          ]
        : [],
      labels: [],
      topScore: evidence.chunks[0]?.score ?? null,
      weak:
        (built.spec.slides[index]?.claimIds.length ?? 0) === 0 &&
        (built.spec.slides[index]?.evidenceIds?.length ?? 0) === 0,
      warnings: section.warnings,
    }));

    log("document built (deck pipeline)", {
      slides: built.sections.length,
      parties: built.spec.entities.length,
      claims: Object.keys(built.spec.claims).length,
      coverage: Number(gate.coverage.toFixed(2)),
      blocked,
      chunks: usedChunkIds.length,
    });

    return {
      model,
      trace: {
        generatedAt: now.toISOString(),
        brief,
        sections: traceSections,
        usedChunkIds,
        openItems,
        warnings: model.warnings,
        retrieval: {
          target: evidence.target.name,
          targetPassages: evidence.target.passages,
          peerPassages: evidence.target.peers,
        },
      },
      usedFallback: built.usedFallback,
      gate,
    };
  }

  // The conversation's analysis is the deck's point of view; passages are its
  // facts. Citations are remapped to this deck's passage numbers first.
  const analysisContext = deckAnalysisContext(input.history, evidence.chunks);

  let deckWarnings: string[] = [];
  let enrichmentWarnings: string[] = [];
  let extraCallUsed = false;
  let normalized: ReturnType<typeof normalizeDeck> = {
    sections: [],
    missing: [...plans],
    warnings: [],
  };

  if (evidence.chunks.length > 0) {
    const deck = await generateDeck(plans, brief, evidence.chunks, null, {
      ...input.provider,
      analysisContext,
      log,
    });
    deckWarnings = deck.warnings;
    normalized = normalizeDeck(
      deck.rawSlides,
      plans,
      evidence.chunks,
      brief,
      new Set<number>(),
    );

    // At most one extra call, and only for slides the first call left empty.
    if (normalized.missing.length > 0) {
      const missingPlans = normalized.missing;
      extraCallUsed = true;
      try {
        const extra = await generateDeck(missingPlans, brief, evidence.chunks, null, {
          ...input.provider,
          analysisContext,
          log,
        });
        const extraNormalized = normalizeDeck(
          extra.rawSlides,
          missingPlans,
          evidence.chunks,
          brief,
          new Set<number>(),
        );
        const byId = new Map(
          [...normalized.sections, ...extraNormalized.sections].map((section) => [
            section.id,
            section,
          ]),
        );
        normalized = {
          sections: [...byId.values()],
          missing: extraNormalized.missing,
          warnings: [...normalized.warnings, ...extraNormalized.warnings],
        };
        deckWarnings = [...deckWarnings, ...extra.warnings];
      } catch (error) {
        log("missing slide regeneration failed", {
          reason: failureReasonOf(error),
          error: String(error).slice(0, 240),
        });
      }
    }
  }

  // Thin-slide enrichment: one batch call, thinking off, only the flagged
  // slides. It is the single extra call the pipeline is allowed; it is skipped
  // when a missing-slide repair already used it.
  if (!extraCallUsed && normalized.sections.length > 0) {
    const thin = thinSlides(normalized.sections);
    if (thin.length > 0) {
      const thinPlans = plans.filter((plan) => thin.some((entry) => entry.id === plan.id));
      try {
        const topics = thin
          .map((entry) => plans.find((plan) => plan.id === entry.id))
          .filter((plan): plan is SectionPlan => Boolean(plan))
          .filter((plan) => {
            const section = normalized.sections.find((entry) => entry.id === plan.id);
            return !section || sectionSourceIds(section).length < 2;
          })
          .slice(0, 2);
        const added = await topUpDeckEvidence({
          client: input.client,
          queries: topics.map((plan) => `${plan.title} ${brief.industry ?? ""}`.trim()),
          industrySlug: input.draft.industrySlug,
          embed: (query) => embedQuery(query, input.provider),
          existing: new Set(evidence.chunks.map((chunk) => chunk.chunkId)),
          log,
        });
        for (const chunk of added) {
          evidence.chunks.push(chunk);
          chunksById.set(chunk.chunkId, chunk.content);
          chunkMeta.set(chunk.chunkId, toSourceRecord(chunk));
        }

        const extra = await generateDeck(thinPlans, brief, evidence.chunks, null, {
          ...input.provider,
          analysisContext,
          enrichment: true,
          log,
        });
        extraCallUsed = true;
        const expanded = normalizeDeck(
          extra.rawSlides,
          thinPlans,
          evidence.chunks,
          brief,
          new Set<number>(),
        );
        const byId = new Map(expanded.sections.map((section) => [section.id, section]));
        normalized = {
          sections: normalized.sections.map((section) => byId.get(section.id) ?? section),
          missing: normalized.missing,
          warnings: [...normalized.warnings, ...expanded.warnings],
        };
        deckWarnings = [...deckWarnings, ...extra.warnings];
        log("thin slides enriched", {
          requested: thinPlans.length,
          expanded: expanded.sections.length,
          reasons: thin.map((entry) => `${entry.title}: ${entry.reasons.join(", ")}`),
        });
      } catch (error) {
        log("thin slide enrichment failed", {
          reason: failureReasonOf(error),
          error: String(error).slice(0, 240),
        });
      }
    }

    // Still thin after one attempt: keep the slides and say so; never block.
    enrichmentWarnings = thinSlides(normalized.sections)
      .filter((entry) => thin.some((before) => before.id === entry.id))
      .map(
        (entry) =>
          `Thin slide "${entry.title}" (${entry.reasons.join(", ")}); review before sharing.`,
      );
  }

  const sectionById = new Map(normalized.sections.map((section) => [section.id, section]));
  // No evidence at all means no document: the library supplies the parties and
  // the offer. The gate refuses it below.
  if (evidence.chunks.length > 0) {
    for (const plan of normalized.missing) {
      const fallback = fallbackSlide(plan, evidence.chunks);
      if (fallback) {
        sectionById.set(plan.id, fallback);
        deckWarnings.push(`Recovered "${plan.title}" from cited passages.`);
      } else {
        deckWarnings.push(`"${plan.title}" had no usable content and was left out.`);
      }
    }
  }

  const ordered = plans
    .map((plan) => sectionById.get(plan.id))
    .filter((section): section is DocumentSection => Boolean(section));

  const verification = await verifyDeckClaims(
    ordered,
    evidence.chunks,
    { ...input.provider, log },
    log,
  );
  const sections = verification.sections;

  // Verification can remove an unsupported claim after enrichment; a slide that
  // is thin now is reported, never regenerated or blocked.
  const postVerifyThin = thinSlides(sections)
    .filter((entry) => !enrichmentWarnings.some((warning) => warning.includes(`"${entry.title}"`)))
    .map(
      (entry) =>
        `Thin slide "${entry.title}" (${entry.reasons.join(", ")}); review before sharing.`,
    );

  const gate = deckGateFor(plans, sections, evidence.chunks);
  const openItems = [
    ...brief.openItems,
    ...verification.unsupported.map((entry) => `Review: "${entry.claim}" on slide ${entry.slide}.`),
    // Slide-level normaliser warnings include "No passage cited" for any slide
    // the model wrote without a reference, so they reach the reader.
    ...normalized.warnings,
    ...enrichmentWarnings,
    ...postVerifyThin,
    ...evidence.warnings,
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  const dedupedOpenItems = [...new Set(openItems)].slice(0, 20);

  const records = sourceRecords(sections, chunksById, chunkMeta);
  const sources = await enrichSources(input.client, records, log);

  const warnings = [
    ...new Set([
      ...evidence.warnings,
      ...deckWarnings,
      ...normalized.warnings,
      ...verification.warnings,
      ...postVerifyThin,
      ...(gate.blocked ? [gate.message] : []),
    ]),
  ];

  const model: DocumentModel = {
    mode: input.draft.mode,
    format: input.draft.type,
    cover: {
      title: brief.documentTitle || input.draft.title,
      subtitle: input.draft.subtitle,
      client: brief.client,
      industry: brief.industry,
      date: coverDate(now),
      request: brief.request || input.draft.prompt,
    },
    sections,
    sources,
    openItems: dedupedOpenItems,
    warnings: [...new Set([...warnings])],
    clientLogo,
  };

  const final = validateModel(model, chunksById);
  if (final.errors.length > 0) {
    log("document validation warnings", { errors: final.errors.slice(0, 8) });
    model.warnings = [...model.warnings, ...final.errors.map((error) => `Validation: ${error}`)];
  }
  model.warnings = [...new Set([...model.warnings, ...final.warnings])];

  const traceSections: DocumentTraceSection[] = plans.map((plan) => {
    const section = sections.find((candidate) => candidate.id === plan.id);
    return {
      id: plan.id,
      kind: plan.kind,
      title: section?.title ?? plan.title,
      query: evidence.queries.join(" | "),
      chunkIds: section ? sectionSourceIds(section) : [],
      labels: [],
      topScore: evidence.chunks[0]?.score ?? null,
      weak: !section || sectionSourceIds(section).length === 0,
      warnings: section?.warnings ?? [],
    };
  });

  const usedChunkIds = [...new Set(traceSections.flatMap((section) => section.chunkIds))];

  log("document built", {
    mode: input.draft.mode,
    format: input.draft.type,
    slides: sections.length,
    confirmedSlides: plans.length,
    flagged: sections.filter((section) => section.flagged).length,
    coverage: Number(gate.coverage.toFixed(2)),
    blocked: gate.blocked,
    chunks: usedChunkIds.length,
    openItems: dedupedOpenItems.length,
    llm_calls: 3 + (extraCallUsed ? 1 : 0),
  });

  return {
    model,
    trace: {
      generatedAt: now.toISOString(),
      brief,
      sections: traceSections,
      usedChunkIds,
      openItems: dedupedOpenItems,
      warnings: model.warnings,
      retrieval: {
        target: evidence.target.name,
        targetPassages: evidence.target.passages,
        peerPassages: evidence.target.peers,
      },
    },
    usedFallback: normalized.missing.length > 0,
    gate,
  };
}
