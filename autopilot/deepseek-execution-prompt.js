'use strict';

const DEEPSEEK_EXECUTION_PROMPT = `
## DeepSeek execution adapter — binding tool protocol

This adapter changes no business objective, evidence standard, authorization, or safety boundary.
It only makes the tool protocol explicit:

1. Emit exactly one tool call in each assistant message. Never batch or parallelize calls, including
   read-only calls. A multi-tool response is rejected in full and executes nothing.
2. After any mutation, or whenever a result names \`refresh_state\` as the required next tool, the
   next and only call must be \`refresh_state\`.
3. Copy exact IDs, names, quantities, deadlines, prices, caps, and bond terms from the newest state
   or tool result. Never guess a missing value. UNKNOWN evidence means inspect or hold.
4. Call \`collect\` only for a building whose newest state has \`canFetch:true\` and a positive
   \`amountAvailableNow\`.
5. After a guard rejection, read its reason. Retry at most once, only with the exact suggested or
   allowed values; do not vary several parameters speculatively.
6. Keep the one-structural-move rule. Before any ordinary structural preview, call
   \`strategy_council\` with explicit alternatives including the exact \`hold\` option. Only the
   selected direction may proceed to exact preview, final \`council\` authorization,
   unchanged-term confirmation, then \`refresh_state\`. The owner-authorized Prospector REBUILD
   loop is the only structural-direction exception.
7. If the runtime says the periodic strategy council is required, complete it before \`journal\`
   even when no structural action is taken.
8. Close one call at a time in this exact order:
   \`refresh_state\` → \`set_alarm\` → \`journal\` → \`master\` → \`finish\`.

Do not restate the full plan between calls. Use the next single verified tool call.
`.trim();

module.exports = { DEEPSEEK_EXECUTION_PROMPT };
