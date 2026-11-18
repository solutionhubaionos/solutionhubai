/**
 * Two realistic deck models for reviewing the PowerPoint renderer.
 *
 * Both are built from the content of decks in the library (spike-input), not from
 * invented filler:
 *  - `movinDeck()` follows the AIONOS x MOVIN process-automation deck and the
 *    Accor/InterGlobe hotel-operations deck: executive thesis, where value leaks,
 *    automation portfolio, KPI contract, approaches, ask.
 *  - `indigoDeck()` follows the IndiGo Fly++ proposal and the IndiGo x InterGlobe
 *    Hotels x Movin travel scenario: market sizing, JV vs SPV, the commercial
 *    shape, the pilot, the ask.
 *
 * They deliberately include the shapes that used to break: a seven-row key/value
 * table, long table cells, an assumption-based chart, a wide table, a long
 * paragraph and a section with prose plus two visuals.
 */
import type { DocumentModel, DocumentSection, SourceRecord } from "../src/lib/documents/types";

const MOVIN_SOURCES: SourceRecord[] = [
  {
    chunkId: "movin-1",
    contentId: "movin-deck",
    title: "AIONOS x MOVIN process automation",
    fileName: "AIONOS_MOVIN_Process_Automation_Transformation.pptx",
    filePath: "library/movin.pptx",
    industry: "logistics",
    customerName: "Movin",
    page: null,
    slide: 2,
    heading: "Executive thesis",
    contentType: "pptx",
    date: "2026-07-04",
  },
  {
    chunkId: "accor-1",
    contentId: "accor-deck",
    title: "AI hotel operating system for Accor and InterGlobe Hotels",
    fileName: "AI_Hotel_Operating_System_Workshop_and_proposal_for_Accor_Interglobe_Hotels.pptx",
    filePath: "library/accor-interglobe.pptx",
    industry: "hospitality",
    customerName: "Accor",
    page: null,
    slide: 11,
    heading: "The spend baseline",
    contentType: "pptx",
    date: "2026-05-14",
  },
  {
    chunkId: "ihg-1",
    contentId: "interglobe-roadmap",
    title: "InterGlobe Hotels roadmap",
    fileName: "InterGlobe_Hotels_Roadmap.pptx",
    filePath: "library/interglobe-hotels-roadmap.pptx",
    industry: "hospitality",
    customerName: "InterGlobe Hotels",
    page: null,
    slide: 31,
    heading: "From fragmented systems to one chain of command",
    contentType: "pptx",
    date: "2025-11-20",
  },
  {
    chunkId: "chalet-1",
    contentId: "chalet-case",
    title: "Chalet Hotels conversational booking case study",
    fileName: "Chalet_Hotels_casestudy.pdf",
    filePath: "library/chalet-hotels.pdf",
    industry: "hospitality",
    customerName: "Chalet Hotels",
    page: 3,
    slide: null,
    heading: "Direct revenue result",
    contentType: "pdf",
    date: "2026-02-11",
  },
];

const INDIGO_SOURCES: SourceRecord[] = [
  {
    chunkId: "indigo-1",
    contentId: "flyplusplus",
    title: "IndiGo Fly++ business proposal",
    fileName: "Fly_IndiGo_25.06.24_full_proposal_.pptx",
    filePath: "library/indigo-flyplusplus.pptx",
    industry: "aviation",
    customerName: "IndiGo",
    page: null,
    slide: 2,
    heading: "A $1 billion opportunity",
    contentType: "pptx",
    date: "2024-06-25",
  },
  {
    chunkId: "indigo-2",
    contentId: "indigo-martech",
    title: "IndiGo MarTech personalisation",
    fileName: "2411_-_IndiGo_MarTech_Personalization_using_Agentic_AI.pptx",
    filePath: "library/indigo-martech.pptx",
    industry: "aviation",
    customerName: "IndiGo",
    page: null,
    slide: 8,
    heading: "Ancillary attach",
    contentType: "pptx",
    date: "2024-11-18",
  },
  {
    chunkId: "indigo-3",
    contentId: "interglobe-roadmap",
    title: "InterGlobe Hotels roadmap",
    fileName: "InterGlobe_Hotels_Roadmap.pptx",
    filePath: "library/interglobe-hotels-roadmap.pptx",
    industry: "hospitality",
    customerName: "InterGlobe Hotels",
    page: null,
    slide: 12,
    heading: "The current estate",
    contentType: "pptx",
    date: "2025-11-20",
  },
  {
    chunkId: "indigo-4",
    contentId: "cargo-case",
    title: "IndiGo cargo pricing case study",
    fileName: "Indigo_AIonOS_CargoPricing_CaseStudy_v1.0.pptx",
    filePath: "library/indigo-cargo.pptx",
    industry: "aviation",
    customerName: "IndiGo",
    page: null,
    slide: 5,
    heading: "Pricing discipline",
    contentType: "pptx",
    date: "2025-03-12",
  },
];

function section(
  input: Partial<DocumentSection> & Pick<DocumentSection, "id" | "kind" | "title" | "blocks">,
): DocumentSection {
  return {
    speakerNotes:
      input.speakerNotes ??
      `Take the room through “${input.title}” in one breath, then stop for the question that matters.`,
    flagged: false,
    warnings: [],
    ...input,
  };
}

export function movinDeck(): DocumentModel {
  return {
    mode: "pitch",
    format: "pptx",
    cover: {
      title: "One guest. One service team. One intelligent hotel.",
      subtitle: "AI-enabled hotel and logistics operations for Movin, InterGlobe Hotels and Accor",
      client: "Movin · InterGlobe Hotels · Accor",
      industry: "Travel, hospitality and logistics",
      date: "13 November 2026",
      request:
        "Pitch a joint AI operating layer for Movin, InterGlobe Hotels and Accor that removes unresolved hand-offs across guest, room and shipment journeys.",
    },
    sections: [
      section({
        id: "thesis",
        kind: "executive_summary",
        title: "The opportunity is not more automation — it is fewer unresolved hand-offs",
        layout: "summary",
        speakerNotes:
          "Open with the outcome: three companies, one execution layer, measurable closure of the hand-offs that leak value today. The missed airport pickup is the whole argument in one story.",
        blocks: [
          {
            type: "paragraph",
            text: "Movin, InterGlobe Hotels and Accor already own the data, systems and workflows. What is missing is the intelligence that connects them, so a failed pickup, an idle room or a disputed delivery becomes an owned action instead of a closed ticket.",
            sources: ["S1"],
          },
          {
            type: "bullet_list",
            sources: ["S1", "S2"],
            items: [
              {
                text: "**41 systems** already feed a single operator's estate, and each hand-off between them is manual",
                sources: ["S2"],
              },
              {
                text: "Service failures are recorded as transactions, never as decisions for the next stay or shipment",
                sources: ["S1"],
              },
              {
                text: "A shared agent layer closes the loop without replacing a single system of record",
                sources: ["S2", "S3"],
              },
            ],
          },
          {
            type: "callout",
            tone: "info",
            text: "Ask: agree a six-week pilot lane across one hotel cluster and one Movin hub, measured against four KPIs.",
            sources: ["S1"],
          },
        ],
      }),
      section({
        id: "value-leak",
        kind: "problem",
        title: "Value leaks in the gap between a signal and the action it should trigger",
        layout: "bullets",
        blocks: [
          {
            type: "paragraph",
            text: "The operating model is familiar and expensive: read the email, copy the field, transfer in chat, reconcile with a supervisor. Every step is a place where a guest or a shipment is forgotten.",
            sources: ["S1"],
          },
          {
            type: "table",
            headers: ["Journey moment", "Today", "What leaks", "Evidence"],
            rows: [
              [
                "Airport pickup",
                "Booked on the prior stay, no follow-up at the next booking",
                "Guest arrives to no car, no recovery",
                "[1]",
              ],
              [
                "Early check-in",
                "Request logged, room readiness not orchestrated",
                "Guest waits in the lobby",
                "[2]",
              ],
              [
                "Room out of order",
                "Engineering closes the work order, room stays blocked",
                "A sellable room disappears for days",
                "[3]",
              ],
              [
                "Cold-room alarm",
                "Compressor reset, kitchen never told",
                "At-risk stock reaches guests",
                "[3]",
              ],
              [
                "Rate parity",
                "Wholesale rate surfaces on an OTA",
                "15–25% commission on owned guests",
                "[3]",
              ],
              [
                "Minibar and damage",
                "Room checked hours after the folio closes",
                "Charge written off or disputed",
                "[3]",
              ],
              [
                "Delivery exception",
                "Status visible only at end of day",
                "First-attempt failures become returns",
                "[4]",
              ],
            ],
            sources: ["S2", "S3", "S4"],
          },
        ],
      }),
      section({
        id: "estate",
        kind: "economics",
        title: "A 41-application estate with spend concentrated in a few platforms",
        layout: "kpis",
        speakerNotes:
          "The spend baseline comes from the operator's own application list. Read the four numbers, then say where the pilot money goes.",
        blocks: [
          {
            type: "paragraph",
            text: "Annual application spend sits at **$1.40M** across 41 systems, and the long tail is where most hand-offs happen. These are the figures the business case starts from.",
            sources: ["S2"],
          },
          {
            type: "kpis",
            sources: ["S2"],
            items: [
              {
                label: "Annual application spend",
                value: "$1.40M",
                note: "Supplied operator data",
                refs: [2],
              },
              { label: "Monthly run-rate", value: "$116.6K", note: "Annual spend ÷ 12", refs: [2] },
              {
                label: "Top-5 concentration",
                value: "87%",
                note: "HR, OTA, PMS, rate distribution",
                refs: [2],
              },
              {
                label: "Zero-cost tools listed",
                value: "6+",
                note: "Bundled with other platforms",
                refs: [2],
              },
            ],
          },
        ],
      }),
      section({
        id: "spend-split",
        kind: "economics",
        title: "Where the spend sits, and what a single intelligence layer could release",
        layout: "chart",
        speakerNotes:
          "The bar chart is the operator's own spend split; the second series is the illustrative saving range from the business case. Say the word illustrative out loud.",
        blocks: [
          {
            type: "chart",
            basis: "assumption",
            sources: ["S2"],
            chart: {
              type: "bar",
              title: "Application spend by system",
              unit: "$K per year",
              categories: ["HR", "OTA", "Others", "PMS", "Rate dist.", "POS"],
              series: [
                { name: "Current spend", values: [313, 283, 224, 212, 180, 53] },
                { name: "Potential release", values: [47, 42, 34, 32, 27, 8] },
              ],
              basis: "assumption",
            },
            caption:
              "Illustrative planning range; the baseline is the operator's application list.",
          },
          {
            type: "bullet_list",
            sources: ["S2"],
            items: [
              { text: "Core platforms, not the long tail, carry the largest addressable spend" },
              {
                text: "A 5–15% release is the planning range for workflow and licence consolidation",
              },
              {
                text: "**87%** of spend sits in five systems, which is where a pilot should start",
              },
            ],
          },
        ],
      }),
      section({
        id: "portfolio",
        kind: "solution",
        title: "Automate the highest-volume moments first",
        layout: "flow",
        blocks: [
          {
            type: "flow",
            sources: ["S1", "S3"],
            steps: [
              {
                label: "Detect",
                detail:
                  "Email, voice, WhatsApp, PMS and shipment events are read for intent and urgency.",
              },
              {
                label: "Decide",
                detail:
                  "The agent combines guest value, stay context, SLA and live inventory before acting.",
              },
              {
                label: "Act",
                detail:
                  "It books, reassigns, notifies or escalates in the system of record with an audit trail.",
              },
              {
                label: "Learn",
                detail:
                  "Closure outcomes feed the next decision, so the same hand-off is never manual again.",
              },
            ],
          },
        ],
      }),
      section({
        id: "kpi-contract",
        kind: "approach",
        title: "Agree four KPIs before the pilot, then manage them weekly",
        layout: "table",
        blocks: [
          {
            type: "table",
            caption: "Each KPI needs a baseline, a pilot lane, an owner and a decision threshold.",
            headers: ["KPI", "Baseline", "Pilot target", "Owner"],
            rows: [
              ["First-attempt delivery success", "87.6%", "91%", "Movin ops"],
              ["Reservation handled without an agent", "35%", "65%", "Accor GCC"],
              [
                "Room back in inventory after repair",
                "3.4 days",
                "8 hours",
                "InterGlobe engineering",
              ],
              ["Complaint closed within SLA", "61%", "85%", "Hotel GM office"],
            ],
            sources: ["S1", "S4"],
          },
        ],
      }),
      section({
        id: "approaches",
        kind: "approach",
        title: "Collaborate now, keep the platform option open",
        layout: "comparison",
        blocks: [
          {
            type: "comparison",
            title: "Criterion",
            criteria: ["Time to value", "Systems touched", "Commercial shape", "Optionality"],
            options: [
              {
                name: "Approach 1 · Integrate",
                values: [
                  "6–8 weeks to first KPI",
                  "Shipsy, PMS and CRM via APIs",
                  "Fixed pilot fee",
                  "Proves the model inside the current stack",
                ],
              },
              {
                name: "Approach 2 · Unifleet",
                values: [
                  "12–16 weeks",
                  "Unifleet becomes the agent layer",
                  "Subscription per shipment",
                  "Owns the interface, not just the workflow",
                ],
              },
            ],
            sources: ["S1"],
          },
        ],
      }),
      section({
        id: "roadmap",
        kind: "timeline",
        title: "Prove value in six weeks, then scale by function",
        layout: "timeline",
        blocks: [
          {
            type: "timeline",
            sources: ["S1"],
            items: [
              {
                label: "Cost & performance baseline",
                timeframe: "Weeks 0–2",
                detail: "Connect the pilot systems, agree the KPI baseline and name the owners.",
              },
              {
                label: "First agents live",
                timeframe: "Weeks 2–6",
                detail:
                  "Appointment, POD and service-recovery agents run with a human in the loop.",
              },
              {
                label: "Measured pilot review",
                timeframe: "Week 7",
                detail: "Compare against baseline, then decide scale, reshape or stop.",
              },
              {
                label: "Function rollout",
                timeframe: "Months 3–6",
                detail: "Extend the same foundation to F&B, finance and engineering workflows.",
              },
            ],
          },
        ],
      }),
      section({
        id: "proof",
        kind: "proof",
        title: "The conversational channel already pays for itself",
        layout: "chart",
        blocks: [
          {
            type: "chart",
            basis: "sourced",
            sources: ["S5"],
            chart: {
              type: "pie",
              title: "Direct booking value by channel",
              unit: "₹ lakh",
              categories: ["WhatsApp", "Website", "Walk-in", "Voice", "OTA"],
              series: [{ name: "Gross booking value", values: [7.02, 5.97, 2.1, 1.4, 0.9] }],
              basis: "sourced",
            },
          },
          {
            type: "paragraph",
            text: "Chalet Hotels moved the majority of direct revenue into a WhatsApp and website concierge, saving **15–30%** of OTA commission on guests it already owned.",
            sources: ["S5"],
          },
        ],
      }),
      section({
        id: "ask",
        kind: "ask",
        title: "Approve the six-week pilot and the four KPI thresholds",
        layout: "text",
        speakerNotes:
          "Close on the decision, not a summary. The pilot is small, the thresholds are written down, and the review date is fixed.",
        blocks: [
          {
            type: "paragraph",
            text: "Start with one hotel cluster and one Movin hub. We fund the build, you name the owners, and both sides review against the four KPI thresholds at week seven.",
            sources: ["S1"],
          },
          {
            type: "bullet_list",
            sources: ["S1"],
            items: [
              { text: "Decision needed by 30 November to start before the peak season" },
              { text: "Named owner per KPI from Accor, InterGlobe Hotels and Movin" },
              { text: "Data-access approval for the four pilot systems" },
            ],
          },
        ],
      }),
    ],
    sources: MOVIN_SOURCES,
    openItems: ["Pilot funding split", "Data-processing agreement"],
    warnings: [],
  };
}

export function indigoDeck(): DocumentModel {
  return {
    mode: "proposal",
    format: "pptx",
    cover: {
      title: "A travel marketplace built on assets you already own",
      subtitle:
        "Proposal for IndiGo, InterGlobe Hotels and Movin: flights, stays and luggage in one journey",
      client: "IndiGo · InterGlobe Hotels · Movin",
      industry: "Aviation, hospitality and logistics",
      date: "13 November 2026",
      request:
        "Propose a jointly owned travel marketplace that packages IndiGo flights, InterGlobe Hotels stays and Movin luggage logistics for the top customer archetypes.",
    },
    sections: [
      section({
        id: "opportunity",
        kind: "executive_summary",
        title: "The group already owns the three assets a travel marketplace needs",
        layout: "summary",
        speakerNotes:
          "Frame the proposal as packaging existing inventory, not building a new business from zero. Three assets, one journey, one commercial shape.",
        blocks: [
          {
            type: "paragraph",
            text: "IndiGo brings distribution and a customer base of roughly **100M** travellers, InterGlobe Hotels brings rooms in the cities those travellers fly to, and Movin brings the baggage leg nobody else can sell. Together they cover a journey end to end.",
            sources: ["S1", "S3"],
          },
          {
            type: "bullet_list",
            sources: ["S1", "S2"],
            items: [
              { text: "Ancillary revenue has grown **10–15% year on year** for five years" },
              { text: "25% of ancillary revenue comes from the Even More bundle" },
              { text: "Packaging rooms and luggage lifts attach rate without new inventory" },
            ],
          },
        ],
      }),
      section({
        id: "market",
        kind: "economics",
        title: "Where the value sits in a packaged journey",
        layout: "chart",
        blocks: [
          {
            type: "chart",
            basis: "assumption",
            sources: ["S1"],
            chart: {
              type: "stacked_bar",
              title: "Revenue per traveller by package",
              unit: "$ per trip",
              categories: ["Flight only", "Flight + stay", "Flight + bag", "Full journey"],
              series: [
                { name: "Airfare", values: [180, 180, 180, 180] },
                { name: "Stay", values: [0, 96, 0, 104] },
                { name: "Luggage", values: [0, 0, 22, 26] },
                { name: "Ancillaries", values: [31, 42, 48, 58] },
              ],
              basis: "assumption",
            },
            caption: "Illustrative planning values built from the deck's per-traveller figures.",
          },
          {
            type: "paragraph",
            text: "Each additional leg adds margin on inventory that is already committed, which is why the full journey is the target model rather than a flights-only marketplace.",
            sources: ["S1"],
          },
        ],
      }),
      section({
        id: "sizing",
        kind: "economics",
        title: "A $1bn opportunity, and the assumptions behind it",
        layout: "kpis",
        blocks: [
          {
            type: "kpis",
            sources: ["S1"],
            items: [
              {
                label: "Market size ambition",
                value: "$1bn",
                note: "Opportunity framed in the proposal",
              },
              {
                label: "Travellers in the base",
                value: "100M",
                note: "Customer profiles and history",
              },
              { label: "Ancillary growth", value: "10–15%", note: "Year on year, last five years" },
            ],
          },
          {
            type: "table",
            headers: ["Metric", "Value"],
            rows: [
              ["Total revenue, 2010", "$3.78bn"],
              ["Ancillary revenue, 2010", "$400M"],
              ["Ancillary per passenger, 2010", "$15"],
              ["Total revenue, 2019", "$8.1bn"],
              ["Ancillary revenue, 2019", "$1.1bn"],
              ["Menus, seats and bags attach", "24%"],
              ["Target attach rate", "35%"],
            ],
            sources: ["S1"],
          },
        ],
      }),
      section({
        id: "structure",
        kind: "parties",
        title: "Two structures, one operating answer",
        layout: "comparison",
        blocks: [
          {
            type: "comparison",
            title: "Criterion",
            criteria: ["Capital", "Control", "Speed", "Exit"],
            options: [
              {
                name: "Joint venture",
                values: [
                  "Shared equity contribution",
                  "Board seats per contribution",
                  "6–9 months to incorporate",
                  "Transfer restrictions apply",
                ],
              },
              {
                name: "Special purpose vehicle",
                values: [
                  "Contractual funding, no equity",
                  "Operating committee",
                  "8–12 weeks to first sale",
                  "Dissolves at term",
                ],
              },
            ],
            sources: ["S2", "S3"],
          },
        ],
      }),
      section({
        id: "commercial",
        kind: "pricing",
        title: "The commercial shape protects each partner's revenue line",
        layout: "table",
        blocks: [
          {
            type: "paragraph",
            text: "Each partner keeps its own inventory and pricing authority; the marketplace earns a packaging fee and a share of the incremental attach. Nothing is cross-subsidised and no partner loses direct-channel margin.",
            sources: ["S1", "S2"],
          },
          {
            type: "table",
            headers: ["Line item", "Basis", "Who earns", "Risk owner"],
            rows: [
              ["Airfare", "Published fare, no discount", "IndiGo", "IndiGo"],
              ["Stay", "Contracted net rate plus markup", "InterGlobe Hotels", "InterGlobe Hotels"],
              ["Luggage leg", "Per-shipment fee", "Movin", "Movin"],
              ["Packaging fee", "3–5% of package value", "Marketplace", "Marketplace"],
              ["Incremental attach share", "50/50 with the inventory owner", "Shared", "Shared"],
            ],
            sources: ["S1", "S2"],
          },
        ],
      }),
      section({
        id: "pilot",
        kind: "approach",
        title: "A pilot on three routes and two cities proves the packaging model",
        layout: "flow",
        blocks: [
          {
            type: "flow",
            sources: ["S2", "S4"],
            steps: [
              {
                label: "Select",
                detail: "Three high-frequency routes paired with two InterGlobe hotels.",
              },
              {
                label: "Package",
                detail: "One bundled price with flight, stay and luggage in a single cart.",
              },
              {
                label: "Fulfil",
                detail: "Movin collects and delivers against the flight and stay timings.",
              },
              {
                label: "Measure",
                detail: "Attach rate, cancellation and margin per traveller against the baseline.",
              },
            ],
          },
        ],
      }),
      section({
        id: "economics",
        kind: "economics",
        title: "What the pilot has to prove before it scales",
        layout: "chart",
        blocks: [
          {
            type: "chart",
            basis: "assumption",
            sources: ["S1", "S2"],
            chart: {
              type: "line",
              title: "Attach rate through the pilot",
              unit: "% of eligible travellers",
              categories: ["Month 1", "Month 2", "Month 3", "Month 4", "Month 5"],
              series: [
                { name: "Flight + stay", values: [4, 7, 11, 14, 17] },
                { name: "Full journey", values: [1, 2, 4, 6, 8] },
              ],
              basis: "assumption",
            },
          },
          {
            type: "bullet_list",
            sources: ["S1", "S2"],
            items: [
              { text: "Attach rate must pass **12%** on flight plus stay to justify rollout" },
              { text: "Cancellation must stay within two points of the flight-only baseline" },
            ],
          },
        ],
      }),
      section({
        id: "risks",
        kind: "shortcomings",
        title: "What could stop this, stated plainly",
        layout: "text",
        blocks: [
          {
            type: "bullet_list",
            sources: ["S2"],
            items: [
              {
                text: "Packaging couples three operating calendars: a delayed flight breaks the stay and the luggage leg together",
                sources: ["S2"],
              },
              {
                text: "Inventory is not guaranteed at peak, so the bundle needs a fallback promise",
              },
              {
                text: "Attach-rate assumptions in this document are planning ranges, not observed results",
              },
            ],
          },
          {
            type: "callout",
            tone: "warning",
            text: "The $1bn figure is a stated market ambition from the source deck, not a forecast this proposal has modelled.",
            sources: ["S1"],
          },
        ],
      }),
      section({
        id: "next",
        kind: "next_steps",
        title: "Approve the pilot and name the operating committee",
        layout: "text",
        blocks: [
          {
            type: "paragraph",
            text: "We propose a joint operating committee with one owner from each partner, a fixed pilot term of four months, and a written review against the three thresholds above.",
            sources: ["S2"],
          },
          {
            type: "bullet_list",
            sources: ["S2"],
            items: [
              { text: "Committee named and pilot routes agreed within two weeks" },
              { text: "Pricing and packaging approved before the first sale" },
            ],
          },
        ],
      }),
    ],
    sources: INDIGO_SOURCES,
    openItems: ["Pilot budget", "Data-sharing agreement"],
    warnings: [],
  };
}
