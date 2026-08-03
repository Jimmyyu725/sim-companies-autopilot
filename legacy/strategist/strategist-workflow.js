// Strategist decision-making as a Workflow (owner directive 2026-07-24: "战略层 decision-making
// 用 workflow"). The old run-strategist.sh fired ONE headless claude that did everything serially;
// this fans the read-only ASSESSMENT out in parallel (rank / audit / alert-triage) and then hands a
// single DECIDE-EXECUTE agent the three briefs to act on. Only the execute agent touches the
// browser, so the parallel phase never races on .tick.lock.
//
// The runner (run-strategist-workflow.sh) gathers the browser-heavy state ONCE before the workflow
// and writes it to scratch files the assess agents read:
//   .strat-state.txt   ← node tick.js --dry   (cash/level/XP/accel/what every building is doing)
//   .strat-books.txt   ← node accounting.js    (operating profit, drains, HIGH recommendations)
//   .strat-rank.txt    ← node industry-report.js (REALIZABLE-ranked, mirage-filtered)
//   board/.realizable.json ← node realizable.js (per-product verdict + realizable $/h)
//   .strat-flags.txt   ← which *.flag files are set + their bodies
//
// args = { wd, flags:[...], stamp }

export const meta = {
  name: 'apple-strategist',
  description: 'Strategist decision-making for apple.co Corp: parallel assess (rank/audit/alerts) then a single decide-execute pass',
  phases: [
    { title: 'Assess', detail: 'rank industries (realizable), audit the books, triage alerts — parallel, read-only' },
    { title: 'Decide', detail: 'one agent synthesizes, applies the skeptic check, executes under flock, journals' },
  ],
}

const WD = args.wd
const FLAGS = (args.flags || []).join(', ') || '(none set)'

phase('Assess')
const assess = await parallel([
  // --- ranker: what should we build/switch to, on REALIZABLE numbers ---
  () => agent(`You are the strategist's industry ranker for apple.co Corp in Sim Companies. READ-ONLY this phase — do NOT touch the browser or game.
Read: ${WD}/.strat-rank.txt (industry-report.js output, already ranked by REALIZABLE $/h with MIRAGE goods dropped), ${WD}/board/.realizable.json (per-kind verdict/realizableRate/realizablePerHour/realizableFraction/bookStale), ${WD}/.strat-state.txt (live cash/level/slots), and DOCTRINE.md Rule 4d + STRATEGIST.md step 4 (standing decisions + the no-Catering/no-Restaurant constraint).
Produce: the top realizable durable targets we could BUILD or SWITCH to (verdict B2B-DEEP or RETAIL-OK only; never MIRAGE/OVERSUPPLIED; B2B-THIN fill-in only), each with realizable $/h, cost, payback, affordability vs current cash, and whether bookStale makes it unproven. Explicitly say whether to arm a buildPlan this run or hold, and why — on realizable numbers, never paper. Flag any free construction slot. Write your brief to ${WD}/.strat-rank.md and reply FILED.`, { label: 'assess:rank', phase: 'Assess' }),
  // --- auditor: the books + cash health ---
  () => agent(`You are the strategist's financial auditor for apple.co Corp in Sim Companies. READ-ONLY this phase — do NOT touch the browser or game.
Read: ${WD}/.strat-books.txt (accounting.js: operating profit, gross margin, biggest cash drains, dated HIGH/MED/LOW recommendations), ${WD}/.strat-state.txt (cash/regime/building states), ${WD}/finance-log.jsonl if present (day-over-day trend), and DOCTRINE.md §4 + STRATEGIST.md steps 1b/6a.
Produce: is operating profit climbing or regressing (and if regressing, the likely cause)? List every HIGH recommendation to act on this run. Run the cash-stuck check: is any cash frozen as sellable inventory that should be liquidated to unblock production (STRATEGIST 6a)? State the current working-capital headroom vs the $5,000 floor. Write to ${WD}/.strat-audit.md and reply FILED.`, { label: 'assess:audit', phase: 'Assess' }),
  // --- alert triage: what each raised flag needs ---
  () => agent(`You are the strategist's alert-triage analyst for apple.co Corp in Sim Companies. READ-ONLY this phase — do NOT touch the browser or game (plan the actions; the decide-execute agent performs them).
Flags raised this run: ${FLAGS}. Read ${WD}/.strat-flags.txt (the flag bodies), the relevant playbook sections in STRATEGIST.md (5=chat, 5b=price, 5c=surplus, 5d=slot, fastloop-stuck=URGENT root-cause), and recent ${WD}/bot.log lines if a stuck/surplus flag is set.
Produce: for EACH raised flag, the specific action it needs, the exact command(s) the execute agent should run, and the skeptic caveat (what must be MEASURED before acting). If fastloop-stuck is set, that is priority #1 — give the suspected root cause. Write to ${WD}/.strat-alerts.md and reply FILED.`, { label: 'assess:alerts', phase: 'Assess' }),
])

phase('Decide')
const decision = await agent(`You are the CHIEF STRATEGIST of apple.co Corp in Sim Companies, running an unattended cron waking. You have full authority (STRATEGIST.md Authority) — do NOT end with a question; act and record.
Read STRATEGIST.md and DOCTRINE.md in ${WD}, then the three assessment briefs: ${WD}/.strat-rank.md, ${WD}/.strat-audit.md, ${WD}/.strat-alerts.md.

Decide and EXECUTE, in this priority order:
1. If fastloop-stuck was flagged: fix the ROOT CAUSE first (buy a genuinely-missing input, correct config.json, or repair a page script), verify on a live 'flock -w 300 .tick.lock node tick.js' run, then delete fastloop-stuck.flag.
2. Handle chat (STRATEGIST 5) if chat-pending — reply in good faith under DOCTRINE §7, then clear paUnread and the flag.
3. Act on price/surplus/slot alerts per the triage brief.
4. Build/switch decision: act ONLY on REALIZABLE $/h from the ranker brief (DOCTRINE Rule 4d) — never paper $/h, never a MIRAGE/OVERSUPPLIED target, honour no-Catering/no-Restaurant. Arm config.buildPlan only if a target is affordable AND its realizable case is proven (not bookStale-unproven); else hold and say why.
5. Act on every HIGH accounting recommendation.

Before ANY spend/build/code-change run the skeptic check (STRATEGIST 6b / DOCTRINE §0): is the deciding number MEASURED this run or ASSUMED? Verify ASSUMED numbers before they gate a spend. Every browser/CDP command MUST be wrapped in 'flock -w 300 .tick.lock ...'. Keep the $500 reserve; never stop the buildings.
Finish by appending a dated entry to ${WD}/JOURNAL.md (what changed, what you did, what you decided against and why, what to watch next run) and clearing any *-pending/*-alert/*-stuck flag you handled. As your VERY LAST action, run Bash \`touch ${WD}/board/.strat-decide-done\` so the runner knows the decide-execute phase actually completed (the runner will NOT clear flags without this sentinel — an unhandled flag must survive to the next run, never be silently wiped). Then reply with a 4-6 line executive summary of what you executed.`, { label: 'decide-execute', phase: 'Decide' })

return {
  assess: assess.map((a, i) => ({ i, ok: !!a })),
  decision,
}
