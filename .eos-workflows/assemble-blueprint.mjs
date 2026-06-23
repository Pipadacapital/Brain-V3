import fs from 'node:fs'

const SRC = '/private/tmp/claude-501/-Users-rishabhporwal-Desktop-Brain-V3/12b58d59-22db-4108-9ba1-96cedee59283/tasks/w30tiwq08.output'
const OUT = '/Users/rishabhporwal/Desktop/Brain V3/docs/strategy/brain-growth-os-blueprint.md'

const r = JSON.parse(fs.readFileSync(SRC, 'utf8')).result
const out = []
const w = (s = '') => out.push(s)

const cap = r.capstone || []
const sec = r.sections || []
const findCap = (kw) => cap.find(c => c.title.toLowerCase().includes(kw))
const findSec = (kw) => sec.find(s => s.title.toLowerCase().includes(kw))

// ---- Header ----
w('# Brain — The AI Growth Operating System for Commerce Brands')
w('### Strategy Blueprint & Engineering Plan')
w()
w('> Produced by a 29-agent dynamic advisory workflow: 5 grounding analysts (read the real repo), 6 competitive-intel analysts (web research on 12 competitors), a 15-persona advisory board (6 councils), 8 principal strategists, 2 capstone authors, and 2 adversarial reviewers. **Every recommendation is grounded in marts/tables/modules that actually exist in this repo** — claims that were not are flagged in the Open Risks appendix.')
w()
w('**Run:** `wf_bde95738-b11` · 29 agents · ~4.1M subagent tokens · grounded in 58 catalogued real capabilities.')
w()
w('---')
w()

// ---- TOC ----
w('## Contents')
w()
const toc = [
  '1. Executive Summary, North Star & Three-Year Vision',
  '2. Competitor Analysis',
  '3. User Personas & Business-Question Catalog',
  '4. Dashboard Requirements (9 dashboards)',
  '5. Insight, Recommendation & Opportunity Engines',
  '6. AI Copilot & Decision Engine',
  '7. Segmentation, Predictive Models & Journey Intelligence',
  '8. Monetization, Pricing & Revenue Strategy',
  '9. Engineering / DB / Medallion / Identity / Pipeline / UI Impact',
  '10. Gap Analysis & Product Roadmap',
  'Appendix A — Open Risks (adversarial critique)',
  'Appendix B — Competitor Intelligence (data)',
  'Appendix C — Advisory Board (15 personas)',
  'Appendix D — Grounded Capability Inventory',
]
toc.forEach(t => w(`- ${t}`))
w()
w('---')
w()

// ---- 1. Capstone exec/vision ----
const execCap = findCap('north star') || cap[0]
w('# 1. Executive Summary, North Star & Three-Year Vision')
w()
if (execCap) w(execCap.markdown)
w()
w('---')
w()

// ---- 2-9 synthesis sections in canonical order ----
const order = [
  ['# 2. Competitor Analysis', findSec('competitor')],
  ['# 3. User Personas & Business-Question Catalog', findSec('persona')],
  ['# 4. Dashboard Requirements', findSec('dashboard')],
  ['# 5. Insight, Recommendation & Opportunity Engines', findSec('insight')],
  ['# 6. AI Copilot & Decision Engine', findSec('copilot')],
  ['# 7. Segmentation, Predictive Models & Journey Intelligence', findSec('segmentation')],
  ['# 8. Monetization, Pricing & Revenue Strategy', findSec('monetization')],
  ['# 9. Engineering / DB / Medallion / Identity / Pipeline / UI Impact', findSec('engineering impact')],
]
for (const [heading, s] of order) {
  w(heading)
  w()
  if (s) { w(`*${s.title}*`); w(); w(s.markdown) }
  else w('_(section missing from workflow output)_')
  w()
  w('---')
  w()
}

// ---- 10. Gap + roadmap ----
const roadCap = findCap('roadmap') || cap[1]
w('# 10. Gap Analysis & Product Roadmap')
w()
if (roadCap) w(roadCap.markdown)
w()
w('---')
w()

// ---- Appendix A: Open Risks ----
w('# Appendix A — Open Risks (Adversarial Critique)')
w()
w('> Two skeptical reviewers (a CTO/Data-lead on groundedness+feasibility, a CRO/VC on revenue+market) were instructed to be ruthless. Their findings are kept verbatim so the strategy is read with eyes open.')
w()
const critLabels = ['Groundedness & Feasibility (CTO/Data-lead lens)', 'Revenue & Market (CRO/VC lens)']
;(r.critiques || []).forEach((c, i) => {
  w(`## A.${i + 1} ${critLabels[i] || 'Reviewer'}`)
  w()
  if (c.verdict) { w(`**Verdict:** ${c.verdict}`); w() }
  const block = (title, arr) => {
    if (!arr || !arr.length) return
    w(`**${title}:**`)
    arr.forEach(x => w(`- ${x}`))
    w()
  }
  block('Ungrounded claims (not backed by real Brain data)', c.ungrounded)
  block('Feasibility risks', c.feasibilityRisks)
  block('Revenue holes', c.revenueHoles)
  block('Generic / fluff', c.fluff)
  block('Missing pieces', c.missing)
})
w('---')
w()

// ---- Appendix B: Competitors ----
w('# Appendix B — Competitor Intelligence (Data)')
w()
const comps = (r.competitors || []).flatMap(g => g.competitors || [])
comps.forEach(c => {
  w(`## ${c.name}`)
  if (c.positioning) w(`**Positioning:** ${c.positioning}`)
  if (c.pricing) w(`**Pricing:** ${c.pricing}`)
  const li = (label, arr) => { if (arr && arr.length) { w(); w(`**${label}:**`); arr.forEach(x => w(`- ${x}`)) } }
  li('Key features', c.keyFeatures)
  li('AI features', c.aiFeatures)
  li('Loved', c.loved)
  li('Hated', c.hated)
  li('Gaps', c.gaps)
  if (c.threatToBrain) { w(); w(`**Threat to Brain:** ${c.threatToBrain}`) }
  if (c.opportunityForBrain) { w(`**Opportunity for Brain:** ${c.opportunityForBrain}`) }
  if (c.sources && c.sources.length) { w(); w(`*Sources:* ${c.sources.join(' · ')}`) }
  w()
})
w('---')
w()

// ---- Appendix C: Advisory ----
w('# Appendix C — Advisory Board (15 Personas, 6 Councils)')
w()
;(r.advisory || []).forEach(council => {
  w(`## Council: ${council.council}`)
  if (council.sharpestChallenge) { w(); w(`**Council's sharpest challenge:** ${council.sharpestChallenge}`); w() }
  ;(council.contributions || []).forEach(p => {
    w(`### ${p.persona}`)
    if (p.insights && p.insights.length) { w('**Insights:**'); p.insights.forEach(x => w(`- ${x}`)) }
    if (p.challengeToBrain) { w(); w(`**Challenge to Brain:** ${p.challengeToBrain}`) }
    if (p.mustBuild && p.mustBuild.length) {
      w(); w('**Must build:**')
      p.mustBuild.forEach(m => w(`- **${m.capability}** — brand: ${m.brandValue} | Brain: ${m.brainValue} | revenue logic: ${m.revenueLogic}`))
    }
    if (p.avoid && p.avoid.length) { w(); w('**Avoid:**'); p.avoid.forEach(x => w(`- ${x}`)) }
    w()
  })
})
w('---')
w()

// ---- Appendix D: Ground inventory ----
w('# Appendix D — Grounded Capability Inventory')
w()
w('> The factual backbone: what genuinely exists in the repo today, with real file/table/mart names and an honest maturity rating (production / partial / stub / absent).')
w()
;(r.ground || []).forEach(area => {
  w(`## ${area.area}`)
  if (area.notes) { w(); w(`_${area.notes}_`); w() }
  ;(area.capabilities || []).forEach(c => {
    w(`- **${c.name}** \`[${c.maturity}]\``)
    if (c.where) w(`  - where: ${c.where}`)
    if (c.dataAvailable) w(`  - data: ${c.dataAvailable}`)
  })
  if (area.gaps && area.gaps.length) { w(); w('**Gaps:**'); area.gaps.forEach(x => w(`- ${x}`)) }
  w()
})

fs.mkdirSync('/Users/rishabhporwal/Desktop/Brain V3/docs/strategy', { recursive: true })
fs.writeFileSync(OUT, out.join('\n'))
const bytes = fs.statSync(OUT).size
console.log(`WROTE ${OUT}`)
console.log(`bytes=${bytes} lines=${out.length}`)
console.log(`sections=${sec.length} capstone=${cap.length} competitors=${comps.length} councils=${(r.advisory||[]).length} critiques=${(r.critiques||[]).length} groundAreas=${(r.ground||[]).length}`)
