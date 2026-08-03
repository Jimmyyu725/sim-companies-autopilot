'use strict';

const journalToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observed: {
      type: 'string',
      minLength: 1,
      maxLength: 700,
      description: 'One concise sentence of fresh facts that mattered this wake.',
    },
    decision: {
      type: 'string',
      minLength: 1,
      maxLength: 700,
      description: 'What was done or deliberately not done.',
    },
    opportunity: {
      type: 'string',
      minLength: 1,
      maxLength: 600,
      description: 'The best overlooked upside or hidden risk identified outside the triggering task or current baseline, plus the evidence needed to act if it is not yet verified.',
    },
    alternatives: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: { type: 'string', minLength: 1, maxLength: 320 },
      description: 'Two to four materially different choices considered, including the credible status quo when relevant.',
    },
    reasons: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 320 },
      description: 'Short evidence-backed reasons, including why a non-coffee filler was selected when applicable.',
    },
    deferred: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 320 },
      description: 'Important actions not taken and the concrete reason or trigger for reconsideration.',
    },
    warehouseAssessment: {
      type: 'string',
      minLength: 1,
      maxLength: 700,
      description: 'Confirm every state.stock entry was reviewed; assign every positive item a concise role (retain/input, production use, retail, exchange, experiment, or evidenced defer) and summarize reserves/surplus.',
    },
    longTerm: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'One sentence naming the operating baseline, leading expansion/pivot benchmark (Tools until verified evidence supports a better candidate), free-slot implication, and next strategy trigger.',
    },
  },
  required: ['observed', 'decision', 'opportunity', 'alternatives', 'reasons', 'deferred', 'warehouseAssessment', 'longTerm'],
};

function normalizeText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} must contain 1..${maxLength} characters`);
  }
  return value.trim().replace(/\s+/gu, ' ');
}

function normalizeList(value, field, { minItems = 0, maxItems = 5, maxLength = 320 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`${field} must contain ${minItems}..${maxItems} items`);
  }
  return value.map((item, index) => normalizeText(item, `${field}[${index}]`, maxLength));
}

function normalizeJournalArgs(args) {
  const allowed = new Set(Object.keys(journalToolSchema.properties));
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('journal input must be an object');
  const unknown = Object.keys(args).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`journal contains unknown fields: ${unknown.join(', ')}`);
  return {
    observed: normalizeText(args.observed, 'observed', 700),
    decision: normalizeText(args.decision, 'decision', 700),
    opportunity: normalizeText(args.opportunity, 'opportunity', 600),
    alternatives: normalizeList(args.alternatives, 'alternatives', { minItems: 2, maxItems: 4 }),
    reasons: normalizeList(args.reasons, 'reasons', { minItems: 1 }),
    deferred: normalizeList(args.deferred, 'deferred'),
    warehouseAssessment: normalizeText(args.warehouseAssessment, 'warehouseAssessment', 700),
    longTerm: normalizeText(args.longTerm, 'longTerm', 500),
  };
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : 'UNKNOWN';
}

function formatWarehouse(stock, complete = false) {
  if (stock === null || stock === undefined) return 'UNKNOWN (warehouse source unavailable)';
  if (!Array.isArray(stock)) return 'UNKNOWN (invalid warehouse shape)';
  if (!stock.length) return complete
    ? '(known empty)'
    : 'UNKNOWN (captured list is empty but warehouse completeness is unverified)';
  return stock.map(entry => {
    const name = String(entry?.name || `kind ${entry?.kind ?? 'UNKNOWN'}`);
    const kind = entry?.kind == null ? '' : ` [${entry.kind}]`;
    return `${name}${kind}=${formatNumber(entry?.amount)}`;
  }).join('; ');
}

function formatStateLine(state) {
  const debt = state?.bonds?.principalOutstanding;
  const slots = `${formatNumber(state?.usedSlots)}/${formatNumber(state?.slotCapacity)} used; ${formatNumber(state?.freeSlots)} free`;
  return `as of ${state?.t || 'UNKNOWN'}; cash $${formatNumber(state?.money)}; debt $${formatNumber(debt)}; slots ${slots}`;
}

function formatWakeSnapshot(state, wakeReason) {
  const warehouseComplete = state?.warehouse?.complete === true
    && state?.warehouse?.allPositiveProductsIncluded === true;
  const completeness = warehouseComplete ? 'complete' : 'UNKNOWN completeness';
  return [
    `🎯 WAKE REASON: ${wakeReason || '(scheduled check)'}`,
    `📊 STATE: ${formatStateLine(state)}`,
    `📦 WAREHOUSE (${completeness}): ${formatWarehouse(state?.stock, warehouseComplete)}`,
  ].join('\n');
}

function prepareJournalEntry(args, state) {
  try {
    const value = normalizeJournalArgs(args);
    const warehouseComplete = state?.warehouse?.complete === true
      && state?.warehouse?.allPositiveProductsIncluded === true;
    const reasons = value.reasons.map(reason => `  - ${reason}`).join('\n');
    const alternatives = value.alternatives.map(option => `  - ${option}`).join('\n');
    const deferred = value.deferred.length
      ? value.deferred.map(item => `  - ${item}`).join('\n')
      : '  - Nothing material.';
    return {
      ok: true,
      value,
      markdown: [
        `- State: ${formatStateLine(state)}`,
        `- Warehouse (${warehouseComplete ? 'complete' : 'UNKNOWN completeness'}): ${formatWarehouse(state?.stock, warehouseComplete)}`,
        `- Observed: ${value.observed}`,
        `- Decision: ${value.decision}`,
        `- Opportunity or risk: ${value.opportunity}`,
        '- Alternatives considered:',
        alternatives,
        '- Why:',
        reasons,
        '- Deferred:',
        deferred,
        `- Warehouse assessment: ${value.warehouseAssessment}`,
        `- Long-term: ${value.longTerm}`,
      ].join('\n'),
    };
  } catch (error) {
    return { ok: false, guard: true, reason: String(error.message || error) };
  }
}

module.exports = {
  formatWakeSnapshot,
  formatWarehouse,
  journalToolSchema,
  normalizeJournalArgs,
  prepareJournalEntry,
};
