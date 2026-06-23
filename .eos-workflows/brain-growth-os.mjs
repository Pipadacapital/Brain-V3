export const meta = {
  name: 'brain-growth-os-blueprint',
  description: 'Design Brain as the AI Growth OS for commerce — grounded research + advisory + 22 deliverables',
  whenToUse: 'Strategic blueprint for transforming Brain from data platform to AI Growth Operating System',
  phases: [
    { title: 'Ground', detail: 'Inventory real lakehouse/architecture capabilities from the repo' },
    { title: 'Research', detail: 'Competitor web research — features, pricing, AI, reviews, gaps' },
    { title: 'Advisory', detail: '15 expert personas (6 councils) challenge Brain direction' },
    { title: 'Synthesize', detail: 'Produce deliverable clusters, fed all prior context' },
    { title: 'Capstone', detail: 'Exec summary / north star / 3-yr vision + roadmap + gaps' },
    { title: 'Critique', detail: 'Adversarial: fluff, ungrounded claims, feasibility, revenue holes' },
  ],
}

const BRAIN = `
BRAIN = an AI-native commerce intelligence platform becoming "The AI Growth Operating System for Commerce Brands."
GOAL: turn collected data into INSIGHTS -> RECOMMENDATIONS -> PREDICTIONS -> ACTIONS -> DECISIONS that (a) grow brands'
revenue/profit/repeat/LTV/ROAS/retention/conversion and cut CAC, and (b) grow Brain's ARR/stickiness/expansion.
ARCHITECTURE (DO NOT bypass): Org->Brand(isolation boundary)->Users->Roles. Postgres OLTP; Neo4j identity graph;
Kafka/Redpanda streaming; S3+Iceberg lakehouse; Spark+dbt transforms; StarRocks serving; Redis cache; AI feature layer.
MEDALLION: Pixel/Connectors -> Kafka -> Bronze(raw,immutable,replayable) -> Silver(canonical entities) ->
Gold(business-ready) -> Feature Layer(AI features/predictions/scores) -> Recommendations/Dashboards.
REAL MARTS THAT EXIST (dbt): gold_executive_metrics, gold_cac, gold_revenue_analytics, gold_revenue_ledger,
gold_marketing_attribution, gold_attribution_paths, gold_customer_360, gold_customer_scores(RFM/churn),
gold_customer_segments, gold_cohorts, feature_customer_daily; silver_customers, silver_product, silver_order_line,
silver_order_state, silver_sessions, silver_touchpoint, silver_checkout_signal, silver_marketing_spend,
silver_shipment(_event). ML platform: model_registry + prediction_log + serving (migrations 0083). Connectors: Shopify,
WooCommerce/Magento, Meta/Google ads, Razorpay, Shopify/GoKwik/Shopflo/Shiprocket logistics, GA4. Universal first-party pixel.
PRINCIPLES: event-driven, lakehouse-first, replayable, immutable, single-source metric registry, explainable AI,
brand isolation, deterministic-before-ML, money=minor units+currency. Build ON the existing stack, do not redesign it.
`

const REPO_HINTS = `Repo paths to read for grounding: db/dbt/models/{staging,intermediate,marts}, packages/metric-engine,
db/migrations/*.sql, apps/core/src/modules/{connector,connector/pixel,identity,journey,attribution,recommendation,decision},
apps/web/src/app (dashboards/pages), packages/feature* and ML platform (model_registry/prediction_log).`

const GROUND_SCHEMA = { type:'object', additionalProperties:false, required:['area','capabilities','realDatasets','gaps','notes'], properties:{
  area:{type:'string'},
  capabilities:{type:'array',items:{type:'object',additionalProperties:false,required:['name','where','dataAvailable','maturity'],properties:{
    name:{type:'string'}, where:{type:'string',description:'real file/table/mart names'}, dataAvailable:{type:'string',description:'what fields/grain actually exist'}, maturity:{type:'string',enum:['production','partial','stub','absent']}}}},
  realDatasets:{type:'array',items:{type:'string'}},
  gaps:{type:'array',items:{type:'string'}},
  notes:{type:'string'} } }

const COMP_SCHEMA = { type:'object', additionalProperties:false, required:['competitors'], properties:{
  competitors:{type:'array',items:{type:'object',additionalProperties:false,required:['name','positioning','keyFeatures','aiFeatures','pricing','loved','hated','gaps','threatToBrain','opportunityForBrain','sources'],properties:{
    name:{type:'string'}, positioning:{type:'string'}, keyFeatures:{type:'array',items:{type:'string'}}, aiFeatures:{type:'array',items:{type:'string'}},
    pricing:{type:'string'}, loved:{type:'array',items:{type:'string'}}, hated:{type:'array',items:{type:'string'}}, gaps:{type:'array',items:{type:'string'}},
    threatToBrain:{type:'string'}, opportunityForBrain:{type:'string'}, sources:{type:'array',items:{type:'string'}}}}} } }

const PERSONA_SCHEMA = { type:'object', additionalProperties:false, required:['council','contributions','sharpestChallenge'], properties:{
  council:{type:'string'},
  contributions:{type:'array',items:{type:'object',additionalProperties:false,required:['persona','insights','challengeToBrain','mustBuild','avoid'],properties:{
    persona:{type:'string'}, insights:{type:'array',items:{type:'string'}}, challengeToBrain:{type:'string'},
    mustBuild:{type:'array',items:{type:'object',additionalProperties:false,required:['capability','brandValue','brainValue','revenueLogic'],properties:{capability:{type:'string'},brandValue:{type:'string'},brainValue:{type:'string'},revenueLogic:{type:'string'}}}},
    avoid:{type:'array',items:{type:'string'}}}}},
  sharpestChallenge:{type:'string'} } }

const SECTION_SCHEMA = { type:'object', additionalProperties:false, required:['title','markdown'], properties:{
  title:{type:'string'}, markdown:{type:'string',description:'Decision-grade markdown. Cite REAL marts/tables/files. Every initiative answers: brand growth, Brain growth, architecture fit, changes required, expected business impact (with a rough quantified range).'} } }

const CRIT_SCHEMA = { type:'object', additionalProperties:false, required:['fluff','ungrounded','feasibilityRisks','revenueHoles','missing','verdict'], properties:{
  fluff:{type:'array',items:{type:'string'}}, ungrounded:{type:'array',items:{type:'string',description:'claims not backed by real Brain data/marts'}},
  feasibilityRisks:{type:'array',items:{type:'string'}}, revenueHoles:{type:'array',items:{type:'string'}}, missing:{type:'array',items:{type:'string'}},
  verdict:{type:'string'} } }

// Phase 1: Ground
phase('Ground')
const groundJobs = [
  ['Gold marts & metric registry', 'gold_* dbt marts + packages/metric-engine registry. Enumerate every business-ready metric/dataset that ACTUALLY exists, its grain, and the columns available to power dashboards/insights/predictions. Flag which KPIs are registry-backed.'],
  ['Silver/Bronze & pipeline', 'silver_* dbt models + Bronze/Iceberg + Kafka topics + Spark sinks. What canonical entities + raw event types actually flow, at what grain, replayable? List real topics/models.'],
  ['Feature layer & ML platform', 'feature_customer_daily + model_registry + prediction_log + serving (migrations ~0083) + recommendation/decision foundations in apps/core/src/modules. What features/scores/models exist vs stubs? Is there an online feature path?'],
  ['Identity graph, 360 & journey', 'Neo4j identity graph + gold_customer_360 + journey/attribution modules. What nodes/edges/identities + journey reconstruction + attribution models actually exist?'],
  ['UI, API & monetization', 'apps/web dashboards/pages + apps/core API surface + billing/subscription/plan tables (migrations). What dashboards/pages ship today? What does the billing/metering layer support (plans, GMV metering, usage)?'],
]
const ground = (await parallel(groundJobs.map(([area,task]) => () =>
  agent(`${BRAIN}\n${REPO_HINTS}\n\nYOU ARE A GROUNDING ANALYST. READ THE ACTUAL REPO (Grep/Glob/Read/Bash) — do not guess. AREA: ${area}.\nTASK: ${task}\nReturn ONLY what genuinely exists in code, with real file/table/mart names. Be honest about maturity. This inventory is the factual backbone every later phase must respect — ungrounded claims downstream are failures.`,
    { label:`ground:${area}`, phase:'Ground', agentType:'general-purpose', schema:GROUND_SCHEMA })))).filter(Boolean)
const groundDigest = JSON.stringify(ground)
log(`Ground complete: ${ground.length} inventories, ${ground.reduce((n,g)=>n+(g.capabilities?.length||0),0)} real capabilities catalogued`)

// Phase 2: Research
phase('Research')
const compPairs = [
  ['Triple Whale','Northbeam'],
  ['Lifetimely','Peel Insights'],
  ['Klaviyo','Postscript'],
  ['Segment','RudderStack'],
  ['Elevar','Rockerbox'],
  ['Daasity','Shopify Analytics / Shopify Magic'],
]
const compResults = (await parallel(compPairs.map((pair,i) => () =>
  agent(`${BRAIN}\n\nYOU ARE A COMPETITIVE-INTEL ANALYST. Use WebSearch + WebFetch (load schemas via ToolSearch if needed). Research these products DEEPLY: ${pair.join(' and ')}.\nFor EACH: positioning; key features; AI/ML features (copilot, anomaly, recommendations, predictions); pricing (real tiers if findable); what customers LOVE and HATE (G2/Shopify App Store/Reddit/Twitter/LinkedIn); concrete feature GAPS; the threat each poses to Brain; and the specific opportunity for Brain to win. Cite source URLs. Be skeptical and specific — no marketing copy.`,
    { label:`research:${pair[0]}+`, phase:'Research', agentType:'general-purpose', schema:COMP_SCHEMA })))).filter(Boolean)
const compDigest = JSON.stringify(compResults)
log(`Research complete: ${compResults.reduce((n,c)=>n+(c.competitors?.length||0),0)} competitors profiled`)

// Phase 3: Advisory
phase('Advisory')
const councils = [
  ['Analytics & Attribution', 'Triple Whale VP Product; Northbeam Attribution Architect; Performance Marketing Director'],
  ['Retention & Lifecycle', 'Lifetimely Retention Lead; Klaviyo Customer Architect; Retention Specialist'],
  ['Data & AI Platform', 'Segment CDP Architect; AI Product Leader'],
  ['Growth & Conversion', 'Ex-Meta Growth Scientist; CRO Specialist'],
  ['Operators', 'DTC Founder; Ecommerce Director; Shopify Plus Consultant'],
  ['Strategy & Success', 'McKinsey Consumer Partner; Customer Success Leader'],
]
const advisory = (await parallel(councils.map(([council,personas]) => () =>
  agent(`${BRAIN}\n\nGROUNDED REALITY (what Brain actually has):\n${groundDigest}\n\nCOMPETITOR INTEL:\n${compDigest}\n\nYOU ARE A SKEPTICAL ADVISORY COUNCIL named "${council}". Inhabit EACH of these personas independently and let them DISAGREE: ${personas}.\nDo NOT assume Brain's current direction is correct. Each persona: (1) sharpest insights; (2) ONE pointed challenge to Brain's plan; (3) the specific capabilities Brain MUST build (each with brand value, Brain value, and revenue logic); (4) what to AVOID/kill. Anchor to data Brain genuinely has. Then the council's single sharpest challenge.`,
    { label:`advisory:${council}`, phase:'Advisory', schema:PERSONA_SCHEMA })))).filter(Boolean)
const advisoryDigest = JSON.stringify(advisory)
log(`Advisory complete: ${councils.length} councils, 15 personas weighed in`)

const CONTEXT = `GROUNDED REALITY:\n${groundDigest}\n\nCOMPETITOR INTEL:\n${compDigest}\n\nADVISORY (15 personas):\n${advisoryDigest}`

// Phase 4: Synthesize
phase('Synthesize')
const clusters = [
  ['Competitor Analysis', 'Deliverable: COMPETITOR ANALYSIS. Synthesize the intel into a sharp comparison: per-competitor strengths/weaknesses, what customers love/hate, where each FAILS, the white-space, and Brain\'s wedge. Include a positioning table and the 5 biggest opportunities for Brain.'],
  ['User Personas & Business Questions', 'Deliverables: USER PERSONA ANALYSIS + BUSINESS QUESTIONS. For Founder/CEO/CMO/Performance Marketer/Ecommerce Manager/Retention Manager/Operations/Customer Success/Marketing Analyst: daily workflow, key decisions, pain points, KPIs, the JTBD Brain must own. Then the canonical question catalog (why-revenue-changed, why-CAC-up, why-ROAS-down, why-churn, which-products/campaigns/customers/actions) — each mapped to the REAL mart that answers it.'],
  ['Dashboard Requirements', 'Deliverable: DASHBOARD REQUIREMENTS for Founder/Executive/Marketing/Customer/Retention/Product/Funnel/Attribution/AI dashboards. For EACH: KPIs (from registry), widgets, charts (type + real mart/columns), embedded insights, recommended ACTIONS. No empty-chart states. Name the gold_* mart powering each widget.'],
  ['Insight + Recommendation + Opportunity Engines', 'Deliverables: INSIGHT ENGINE (anomaly/trend/risk/opportunity with severity+priority+impact scoring), RECOMMENDATION ENGINE (what/why/do-what/expected-impact/confidence), OPPORTUNITY ENGINE (lost revenue, abandoned/high-value customers, upsell/cross-sell/retention/campaign/product with $ impact). Specify deterministic-first detection over real marts, explainability contract, and how $ impact is computed.'],
  ['AI Copilot + Decision Engine', 'Deliverables: AI COPILOT (daily/weekly/monthly briefings + exec summaries: what-changed/why/what-to-do/what-if) and DECISION ENGINE (suggested->approved->automated actions e.g. budget shift, segment, campaign; guardrails, human-in-loop, audit log, write-back). Specify grounding (RAG over marts + metric registry, no numbers from the model), cost-tier routing, action execution + reversal.'],
  ['Segmentation + Predictive + Journey', 'Deliverables: SEGMENTATION (VIP/churn-risk/high-intent/discount-seeker/loyal/repeat + dynamic), PREDICTIVE MODELS (churn, LTV, next-purchase, conversion, scoring — features from feature_customer_daily/gold_customer_scores, training/serving via model_registry+prediction_log, eval gates, explainability), CUSTOMER JOURNEY INTELLIGENCE (journey/drop-off/conversion over silver_touchpoint/sessions). Deterministic baselines before ML; how each feeds Opportunity/Decision engines.'],
  ['Monetization + Pricing + Revenue', 'Deliverables: MONETIZATION + PRICING + REVENUE STRATEGY. What customers pay/upgrade for; tiered plans (Free/Core/Growth/AI/Enterprise), AI add-ons, usage/GMV pricing, expansion/upsell, land-and-expand. Tie pricing to value-metrics Brain can meter (events, GMV, brands, AI actions). Model ARR drivers, NRR, path to indispensability. Specific example price points + packaging.'],
  ['Engineering / DB / Medallion / Identity / Pipeline / UI Impact', 'Deliverable: ENGINEERING IMPACT for TOP initiatives. Per initiative: product/DB/API/UI/pipeline/AI/feature impact. DATABASE (tables/columns/indexes/relationships, normalization+scale). MEDALLION (Bronze/Silver/Gold/Feature changes — respect existing). IDENTITY (Neo4j nodes/edges). PIPELINE (events/topics/Spark/dbt). UI EVOLUTION (pages/widgets/workflows). End with a concrete BUILDABLE FIRST-SLICE spec (flagship) wired to existing marts, exact files/marts touched.'],
]
// Paced 2-at-a-time (server-side rate-limit guard — 8 concurrent large-output agents tripped a throttle).
const synthThunks = clusters.map(([title,task]) => () =>
  agent(`${BRAIN}\n\n${CONTEXT}\n\nYOU ARE A PRINCIPAL PRODUCT+ENG STRATEGIST. Write the deliverable below as decision-grade markdown. GROUND EVERYTHING in the real marts/tables/modules from the inventory — name them. Every initiative must answer: (a) how it helps BRANDS grow, (b) how it helps BRAIN grow, (c) how it fits existing architecture, (d) what changes are required, (e) expected business impact with a rough quantified range. Specific, skeptical, buildable — not visionary fluff.\n\nDELIVERABLE: ${task}`,
    { label:`synth:${title}`, phase:'Synthesize', schema:SECTION_SCHEMA }))
const sections = []
for (let bi = 0; bi < synthThunks.length; bi += 2) {
  const res = (await parallel(synthThunks.slice(bi, bi + 2))).filter(Boolean)
  sections.push(...res)
}
const sectionsDigest = sections.map(s=>`## ${s.title}\n${s.markdown}`).join('\n\n')
log(`Synthesis complete: ${sections.length} deliverable clusters drafted`)

// Phase 5: Capstone
phase('Capstone')
const capstoneJobs = [
  ['Executive Summary, North Star & 3-Year Vision', 'Deliverables: EXECUTIVE SUMMARY (1-page, decision-grade), BRAIN NORTH STAR (one metric + why), THREE-YEAR VISION (yr1 trust+insight, yr2 recommendation+prediction, yr3 autonomous decisioning). Tie to real architecture + synthesized strategy. State the bet, the wedge vs competitors, why Brain becomes indispensable.'],
  ['Product Roadmap & Gap Analysis', 'Deliverables: GAP ANALYSIS (current vs future Brain: missing features/data/services/UI/AI/capabilities — grounded in inventory) and PRODUCT ROADMAP (0-3 / 3-6 / 6-12 / 12-24 months) prioritized by business impact x revenue impact x eng effort. Each item: outcome, owner-area, real marts/pipelines touched, success metric.'],
]
const capstone = (await parallel(capstoneJobs.map(([title,task]) => () =>
  agent(`${BRAIN}\n\n${CONTEXT}\n\nALREADY-DRAFTED DELIVERABLES:\n${sectionsDigest}\n\nYOU ARE THE CHIEF PRODUCT & STRATEGY OFFICER writing the capstone. Cohesive with everything above, grounded in real marts, skeptical, quantified. ${task}\n\nReturn decision-grade markdown.`,
    { label:`capstone:${title}`, phase:'Capstone', schema:SECTION_SCHEMA })))).filter(Boolean)
log(`Capstone complete`)

// Phase 6: Critique
phase('Critique')
const fullDraft = [...capstone, ...sections].map(s=>`## ${s.title}\n${s.markdown}`).join('\n\n')
const critiques = (await parallel([
  ['groundedness+feasibility', 'You are a SKEPTICAL CTO/Data-lead reviewer. Hunt: claims NOT backed by real Brain marts/data; medallion/architecture violations; infeasible ML (no features/labels); anything bypassing the lakehouse. Be ruthless.'],
  ['revenue+market', 'You are a SKEPTICAL CRO/VC reviewer. Hunt: weak revenue logic (Brain AND brands), pricing that cannot be metered, undifferentiated me-too features vs competitors, the biggest strategic risk that makes this fail. Be ruthless.'],
].map(([lens,brief]) => () =>
  agent(`${BRAIN}\n\nINVENTORY (ground truth):\n${groundDigest}\n\nFULL STRATEGY DRAFT:\n${fullDraft}\n\n${brief}\nReturn concrete, quotable findings (reference the section) — fluff, ungrounded claims, feasibility risks, revenue holes, missing pieces — plus a one-line verdict.`,
    { label:`critique:${lens}`, phase:'Critique', schema:CRIT_SCHEMA })))).filter(Boolean)
log(`Critique complete`)

return { ground, competitors: compResults, advisory, sections, capstone, critiques }
