/**
 * Fixtures for the answer-quality eval. Retrieved chunks mirror what
 * search_chunks returns, so context building, entity scope, relevance filtering
 * and citation handling can all run without a database.
 */
import type { RetrievedChunk } from "../../src/lib/rag/search";

export function chunk(overrides: Partial<RetrievedChunk> & { title: string }): RetrievedChunk {
  const slug = overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    chunkId: `${slug}-${overrides.slide ?? overrides.page ?? 1}-chunk`,
    contentId: `${slug}-content`,
    content: "",
    page: null,
    slide: null,
    heading: null,
    fileName: `${overrides.title}`,
    filePath: `library/${slug}`,
    industry: "travel",
    customerName: null,
    vectorRank: 1,
    textRank: null,
    score: 0.02,
    ...overrides,
  };
}

const zurich = {
  title: "Zurich Airport Data Maturity Proposal",
  fileName: "Zurich Airport Data Maturity Proposal.pptx",
  customerName: "Zurich Airport",
  industry: "airports",
};

const adani = {
  title: "Adani Airports Digital Operations Deck",
  fileName: "Adani Airports Digital Operations Deck.pptx",
  customerName: "Adani Airports",
  industry: "airports",
};

const hotelProcurement = {
  title: "POV - Hotel procurement marketplace V4",
  fileName: "POV - Hotel procurement marketplace V4.pptx",
  // Deliberately misspelled, as the uploaded metadata is.
  customerName: "InterGlode Hotels",
  industry: "hospitality",
};

const hotelRoadmap = {
  title: "InterGlobe Hotels Roadmap",
  fileName: "InterGlobe Hotels Roadmap.pptx",
  customerName: "InterGlode Hotels",
  industry: "hospitality",
};

export const ZURICH_MATURITY = chunk({
  ...zurich,
  slide: 4,
  heading: "Data maturity horizons",
  content:
    "The engagement proposes a four-level data maturity model. Level 1 is reporting, level 2 is governed self-service, level 3 is predictive operations and level 4 is an autonomous airport. The roadmap runs across three horizons: stabilise in the first six months, industrialise in months six to eighteen, then scale predictive use cases across terminal and airside operations.",
  score: 0.032,
  vectorRank: 1,
  textRank: 1,
});

export const ZURICH_GOVERNANCE = chunk({
  ...zurich,
  slide: 7,
  heading: "Governance model",
  content:
    "A joint data office with Zurich Airport owns the catalogue, the quality rules and the access model, with a monthly steering committee chaired by the CIO. Ownership of each domain sits with the business unit that produces the data.",
  score: 0.027,
  vectorRank: 3,
  textRank: 6,
});

export const ADANI_OPERATIONS = chunk({
  ...adani,
  slide: 12,
  heading: "Airside control tower",
  content:
    "Adani Airports runs a centralised operations control tower covering eight airports, with a shared service desk, common incident taxonomy and a single passenger-flow dashboard used by every airport operator.",
  score: 0.025,
  vectorRank: 4,
  textRank: 2,
});

export const HOTEL_MARKETPLACE = chunk({
  ...hotelProcurement,
  slide: 9,
  heading: "Marketplace model",
  content:
    "The proposed marketplace aggregates hotel suppliers across categories so properties can compare rates and terms in one place. It combines a procurement platform, supplier onboarding and spend analytics, with a phased rollout starting in the largest cities.",
  score: 0.031,
  vectorRank: 1,
  textRank: 2,
});

export const HOTEL_ROADMAP_TITLE_ONLY = chunk({
  ...hotelRoadmap,
  slide: 2,
  heading: "2A. Hospitality Marketplace and Tools Case-Studies",
  content: "2A. Hospitality Marketplace and Tools Case-Studies",
  score: 0.022,
  vectorRank: 2,
  textRank: null,
});

export const HOTEL_DIVIDER = chunk({
  ...hotelProcurement,
  slide: 3,
  heading: "Approach",
  content: "3. Approach and workstreams",
  score: 0.021,
  vectorRank: 5,
  textRank: null,
});

export const DIVIDER_ONLY = chunk({
  ...hotelRoadmap,
  slide: 5,
  heading: "Programme structure",
  content: "5. Programme structure",
  score: 0.019,
  vectorRank: 1,
  textRank: null,
});

/** All known customer spellings the evaluator's fake similarity function sees. */
export const KNOWN_CUSTOMERS = [
  "Zurich Airport",
  "Adani Airports",
  "InterGlode Hotels",
  "InterGlobe Hotels",
  "Accor Hotels",
  "Oberoi Hotels",
];

/** Noisy retrieval: Zurich question, but Adani slides rank in the top 8. */
export const ZURICH_RETRIEVAL: RetrievedChunk[] = [
  ZURICH_MATURITY,
  ADANI_OPERATIONS,
  ZURICH_GOVERNANCE,
  chunk({
    ...adani,
    slide: 4,
    heading: "Why now",
    content:
      "Airport operators are moving from terminal automation to airport-wide intelligence, and the operating model has to change with it.",
    score: 0.018,
    vectorRank: 6,
  }),
];

/** Noisy retrieval: hotel question, with a title-only divider in the mix. */
export const HOTEL_RETRIEVAL: RetrievedChunk[] = [
  HOTEL_MARKETPLACE,
  HOTEL_ROADMAP_TITLE_ONLY,
  HOTEL_DIVIDER,
  chunk({
    ...zurich,
    slide: 2,
    heading: "Agenda",
    content: "Agenda and introductions for the programme steering group.",
    score: 0.018,
    vectorRank: 9,
  }),
];

export const TITLE_ONLY_RETRIEVAL: RetrievedChunk[] = [DIVIDER_ONLY];

export const HISTORY_ADANI: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "What was proposed to Adani airports?" },
  {
    role: "assistant",
    content: "A centralised operations control tower across eight airports [1].",
  },
];
