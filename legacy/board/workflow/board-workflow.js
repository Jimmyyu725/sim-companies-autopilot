// apple.co Corp board meeting, run as a multi-agent Workflow instead of the old sequential
// bash runner (run-board.sh). The bash version called `timeout 900 claude -p` once per role
// per round; at --effort max a Round-2 brief (which must read the full ~54KB of Round-1) ran
// past 900s, got SIGKILLed, and returned a 15-char stub the retry loop could never satisfy —
// the 2026-07-23 9pm meeting deadlocked exactly this way. Workflow agents run to completion
// (owner directive 2026-07-23: "do not timeout-kill the board"), and Rounds 1/2 fan out in
// parallel so the whole meeting is 2-3x faster.
//
// Data flow is file-based so nothing large is threaded through prompts and the bash runner can
// assemble deterministic minutes afterwards:
//   runner writes  board/.meeting-memo.md  (prior meeting + tabled agenda) and a fresh
//                  board-data.json, and clears board/.r1-*.md / .r2-*.md / .r3-ceo.md
//   each R1 agent  reads CHARTER + its role file + its board-data slice + the memo, then
//                  WRITES board/.r1-<ROLE>.md
//   each R2 agent  reads ALL board/.r1-*.md, then WRITES board/.r2-<ROLE>.md
//   the CEO agent  reads every .r1/.r2 file, applies the skeptic check, EXECUTES survivors
//                  under flock, WRITES board/.r3-ceo.md, and appends to JOURNAL.md
//   runner         stitches the .r1/.r2/.r3 files into minutes/ and scps to the desktop
//
// args = { wd, roles:[...], stamp, testR1Only? }  (testR1Only runs only Round 1, for a
// game-safe mechanics probe — the CEO never executes).

export const meta = {
  name: 'apple-board-meeting',
  description: 'Three-round board deliberation (CFO/COO/CMO + CTO/HR when unlocked) for apple.co Corp, replacing the timeout-killing bash runner',
  phases: [
    { title: 'Round1', detail: 'each active executive files proposals — parallel, run to completion' },
    { title: 'Round2', detail: 'each executive cross-examines every peer — parallel' },
    { title: 'Round3', detail: 'CEO applies the skeptic check, ratifies survivors, and executes' },
  ],
}

// The Workflow runtime may hand `args` over as a JSON string rather than an object, so normalize.
const ARGS = typeof args === 'string' ? JSON.parse(args) : (args || {})
const WD = ARGS.wd
const ROLES = ARGS.roles

const r1Prompt = (role) => `You are the ${role} of apple.co Corp in Sim Companies. Read board/CHARTER.md and board/${role}.md in ${WD}, then read your data slice from board-data.json (the '${role.toLowerCase()}' key plus 'market' and top-level level/capabilities), and read board/.meeting-memo.md (prior meeting + tabled agenda).

Produce your Round 1 brief in the shape CHARTER.md specifies, ENDING in an explicit PROPOSALS list — each action paired with the MEASURED number that justifies it, or 'No proposals this round' if none. Numbers over narration. Do NOT re-propose anything the prior meeting explicitly killed unless you have NEW numbers; DO address any deferred agenda seed in your domain. Do NOT modify game state or touch the browser this round.

When finished, WRITE your full brief to ${WD}/board/.r1-${role}.md with the Write tool, then reply with exactly: FILED ${role}.`

const r2Prompt = (role) => `You are the ${role} of apple.co Corp in Sim Companies. Read board/CHARTER.md and board/${role}.md in ${WD}. The board's Round 1 proposals are the files ${WD}/board/.r1-*.md — read ALL of them (yours and every peer's). Respond to every OTHER executive's proposals with support / object / amend, each backed by YOUR domain's MEASURED numbers from board-data.json. Say plainly whether each peer proposal should proceed, and revise your own proposals if a peer's point is valid. This is where a hire, a debt, a research spend, or a build/upgrade/scrap/pivot survives scrutiny or dies. Do NOT modify game state or touch the browser this round.

When finished, WRITE your response to ${WD}/board/.r2-${role}.md, then reply with exactly: FILED ${role}.`

const ceoPrompt = `You are the CEO of apple.co Corp in Sim Companies, chairing the board. Read STRATEGIST.md, DOCTRINE.md and board/CHARTER.md in ${WD}, then read EVERY ${WD}/board/.r1-*.md (proposals) and ${WD}/board/.r2-*.md (cross-examination).

A proposal may be executed ONLY if it survived Round 2 — you cannot approve anything the board demolished, though you may veto or defer a survivor with reason. If a role's .r1 or .r2 file is missing or nearly empty, that role did not deliberate: none of its OWN proposals may be executed (they went unexamined), but the other executives' proposals still stand or fall on their own cross-examination — note the absent role in the journal.

Before you APPROVE or REJECT anything, run the CHARTER skeptic check: is the deciding number MEASURED (read from the game/API this meeting) or ASSUMED? Do not execute a spend on an ASSUMED number without verifying it in-game first; do not kill a proposal on an ASSUMED objection — verify it or downgrade to "deferred pending test".

Then EXECUTE the approved decisions: wrap EVERY browser/CDP command in 'flock -w 300 .tick.lock ...' (the 2-minute fast loop shares the browser tab), and obey all DOCTRINE constraints — no scrap without board approval, no real money, no Sim Boosts, keep the Beach market, hold a $500 cash reserve.

WRITE your full ruling to ${WD}/board/.r3-ceo.md: each executive's headline proposal, what the board approved / amended / killed and why, what you executed, what was deferred, and END it with a VERIFICATION ledger (MEASURED / ASSUMED / UNKNOWN) for the decisions you made. Append that same dated BOARD MEETING entry to ${WD}/JOURNAL.md. Clear any *-pending.flag you acted on. If tabled agenda items (board-agenda-*.md) were addressed, move each handled file into minutes/ (e.g. mv board-agenda-fastloop.md minutes/agenda-fastloop-handled-<date>.md) so it is not re-tabled. Finally reply with a 3-5 line executive summary of what you executed.`

// ---- Round 1: proposals, in parallel -----------------------------------------
phase('Round1')
const r1 = await parallel(ROLES.map(role => () =>
  agent(r1Prompt(role), { label: `R1:${role}`, phase: 'Round1' })
))

if (ARGS.testR1Only) {
  return { testR1Only: true, round1: ROLES.map((role, i) => ({ role, status: r1[i] })) }
}

// ---- Round 2: cross-examination, in parallel ---------------------------------
phase('Round2')
const r2 = await parallel(ROLES.map(role => () =>
  agent(r2Prompt(role), { label: `R2:${role}`, phase: 'Round2' })
))

// ---- Round 3: CEO ratifies and executes --------------------------------------
phase('Round3')
const ceo = await agent(ceoPrompt, { label: 'R3:CEO', phase: 'Round3' })

return {
  round1: ROLES.map((role, i) => ({ role, status: r1[i] })),
  round2: ROLES.map((role, i) => ({ role, status: r2[i] })),
  ceo,
}
