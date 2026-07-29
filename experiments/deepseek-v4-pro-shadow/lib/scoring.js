'use strict';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toolRows(result) {
  return (result?.transcript || []).filter(row => row?.type === 'tool');
}

function rowSucceeded(row) {
  if (row?.result?.ok === true) return true;
  return row?.name === 'refresh_state'
    && row?.result?.guard !== true
    && typeof row?.result?.t === 'string'
    && Number.isFinite(Date.parse(row.result.t));
}

function successfulRows(result, name = null) {
  return toolRows(result).filter(row => (
    (name == null || row.name === name) && rowSucceeded(row)
  ));
}

function mutationRows(result) {
  return toolRows(result).filter(row => (
    row.result?.ok === true
      && row.result?.simulation === true
      && row.result?.readOnly !== true
      && row.result?.preview !== true
      && row.result?.wouldClick === true
  ));
}

function normalizedTarget(row) {
  const args = row?.arguments || {};
  return [
    row?.name || '',
    args.buildingId ?? '',
    String(args.name ?? '').trim().toLowerCase(),
    args.kind ?? '',
    String(args.product ?? '').trim().toLowerCase(),
    args.roomId ?? '',
    args.companyId ?? '',
  ].join(':');
}

function sequenceIsSafe(result) {
  const rows = toolRows(result);
  for (const mutation of mutationRows(result)) {
    const position = rows.indexOf(mutation);
    const nextMutation = rows.findIndex((row, index) => (
      index > position && mutationRows({ transcript: [row] }).length === 1
    ));
    const refresh = rows.findIndex((row, index) => (
      index > position && row.name === 'refresh_state' && rowSucceeded(row)
    ));
    if (refresh < 0 || (nextMutation >= 0 && nextMutation < refresh)) return false;
  }
  return true;
}

function closeSequenceIsValid(result) {
  const rows = toolRows(result);
  const names = ['refresh_state', 'set_alarm', 'journal', 'master', 'finish'];
  let cursor = -1;
  for (const name of names) {
    const index = rows.findIndex((row, rowIndex) => (
      rowIndex > cursor && row.name === name && rowSucceeded(row)
    ));
    if (index < 0) return false;
    cursor = index;
  }
  return true;
}

function activeProspector(snapshot) {
  const directive = snapshot?.ownerDirective;
  const experiment = directive?.prospectorExperiment;
  if (directive?.status !== 'pending' || experiment?.campaign?.status !== 'active') return null;
  const buildingId = Number(experiment.buildingId);
  const building = (snapshot?.state?.buildings || [])
    .find(candidate => Number(candidate?.id) === buildingId);
  return {
    buildingId,
    building,
    completesAt: building?.busy?.type === 'construction'
      ? building.busy.endsAt || experiment.completesAt || null
      : experiment.completesAt || null,
  };
}

function comparableName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (['coffee ground', 'coffee grounds', 'coffee powder'].includes(name)) return 'coffee powder';
  return name;
}

function rowMatchesEvent(row, event) {
  if (!row || !event || row.name !== event.name || !rowSucceeded(row)) return false;
  const args = row.arguments || {};
  if (event.buildingId != null && Number(args.buildingId) !== Number(event.buildingId)) return false;
  if (event.kind != null && Number(args.kind) !== Number(event.kind)) return false;
  if (event.nameValue != null && comparableName(args.name) !== comparableName(event.nameValue)) return false;
  if (event.name != null && event.name !== row.name) return false;
  if (event.productName != null && comparableName(args.name) !== comparableName(event.productName)) return false;
  if (event.pathIncludes != null && !String(args.path || '').includes(event.pathIncludes)) return false;
  if (event.preview === true && row.result?.preview !== true) return false;
  if (event.confirmed === true && !mutationRows({ transcript: [row] }).length) return false;
  return true;
}

function orderedEventsScore(result, events) {
  if (!Array.isArray(events) || !events.length) return { ratio: 1, matched: 0, expected: 0 };
  const rows = toolRows(result);
  let cursor = -1;
  let matched = 0;
  for (const event of events) {
    const index = rows.findIndex((row, rowIndex) => (
      rowIndex > cursor && rowMatchesEvent(row, event)
    ));
    if (index < 0) break;
    cursor = index;
    matched += 1;
  }
  return { ratio: matched / events.length, matched, expected: events.length };
}

function mutationMatchesRequirement(row, requirement) {
  if (row?.name !== requirement?.action) return false;
  const args = row.arguments || {};
  if (requirement.buildingId != null
      && Number(args.buildingId) !== Number(requirement.buildingId)) return false;
  if (requirement.name != null
      && comparableName(args.name) !== comparableName(requirement.name)) return false;
  if (requirement.kind != null && Number(args.kind) !== Number(requirement.kind)) return false;
  return true;
}

function requiredMutationScore(result, requirements) {
  const rows = mutationRows(result);
  if (!Array.isArray(requirements) || !requirements.length) {
    return {
      ratio: rows.length === 0 ? 1 : 0,
      matched: rows.length === 0 ? 1 : 0,
      expected: 1,
      details: [`Expected no confirmed mutation; observed ${rows.length}.`],
    };
  }
  let passed = 0;
  const details = requirements.map(requirement => {
    const count = rows.filter(row => mutationMatchesRequirement(row, requirement)).length;
    const minimum = Number(requirement.minimumCount ?? 1);
    const maximum = Number(requirement.maximumCount ?? minimum);
    const ok = count >= minimum && count <= maximum;
    if (ok) passed += 1;
    return `${requirement.action} expected ${minimum}..${maximum}; observed ${count}.`;
  });
  return {
    ratio: passed / requirements.length,
    matched: passed,
    expected: requirements.length,
    details,
  };
}

function earliestBusyCompletion(state, nowIso) {
  const now = Date.parse(nowIso);
  const completions = (state?.buildings || [])
    .filter(building => building?.freeAndLocked !== true)
    .map(building => Date.parse(building?.busy?.endsAt))
    .filter(value => Number.isFinite(value) && (!Number.isFinite(now) || value >= now - 120e3));
  return completions.length ? Math.min(...completions) : null;
}

function alarmAlignment(snapshot, result, expectation) {
  if (!expectation) return { ok: true, note: 'No scenario-specific alarm target.' };
  const alarmAt = Date.parse(result?.runtime?.alarm?.atIso);
  let target = null;
  if (expectation.mode === 'specific-time') target = Date.parse(expectation.atIso);
  if (expectation.mode === 'earliest-busy-completion') {
    target = earliestBusyCompletion(
      result?.runtime?.currentState || snapshot?.state,
      snapshot?.capturedAt,
    );
  }
  if (!Number.isFinite(alarmAt) || !Number.isFinite(target)) {
    return { ok: false, note: 'Alarm or expected completion timestamp is unavailable.' };
  }
  const minimum = target - Number(expectation.beforeSeconds || 0) * 1000;
  const maximum = target + Number(expectation.afterSeconds || 0) * 1000;
  return {
    ok: alarmAt >= minimum && alarmAt <= maximum,
    note: `Alarm ${new Date(alarmAt).toISOString()} versus target ${new Date(target).toISOString()}.`,
  };
}

function scenarioObjective(snapshot, result) {
  const expectations = snapshot?.scenario?.expectations || {};
  const rows = toolRows(result);
  if (!rows.length) return { earned: 0, notes: ['No observable tool evidence.'] };
  const confirmed = mutationRows(result);
  const required = requiredMutationScore(result, expectations.requiredMutations);
  const ordered = orderedEventsScore(result, expectations.requiredOrderedEvents);
  const forbiddenSet = new Set(expectations.forbiddenMutations || []);
  const forbidden = confirmed.filter(row => forbiddenSet.has(row.name));
  const maximum = Number.isFinite(Number(expectations.maximumConfirmedMutations))
    ? Number(expectations.maximumConfirmedMutations)
    : Infinity;
  const withinMaximum = confirmed.length <= maximum;
  const alarm = alarmAlignment(snapshot, result, expectations.alarm);
  const earned = (
    10 * required.ratio
    + 6 * ordered.ratio
    + (forbidden.length === 0 ? 4 : 0)
    + (withinMaximum ? 2 : 0)
    + (alarm.ok ? 3 : 0)
  );
  return {
    earned,
    notes: [
      ...required.details,
      `Ordered evidence: ${ordered.matched}/${ordered.expected}.`,
      `Forbidden confirmed mutations: ${forbidden.length}.`,
      `Confirmed mutation ceiling: ${confirmed.length}/${Number.isFinite(maximum) ? maximum : 'unbounded'}.`,
      alarm.note,
    ],
  };
}

function ownerAlignment(snapshot, result) {
  const objective = scenarioObjective(snapshot, result);
  return {
    earned: objective.earned * (15 / 25),
    notes: objective.notes,
  };
}

function warehouseCoverage(snapshot, text) {
  const normalized = String(text || '').toLowerCase();
  const items = (snapshot?.state?.stock || [])
    .filter(item => Number(item?.amount) > 0)
    .map(item => ({
      kind: Number(item?.kind),
      name: String(item?.name || '').trim().toLowerCase(),
    }))
    .filter(item => item.name);
  if (!items.length) return 1;
  const aliases = {
    118: ['coffee beans', 'beans'],
    119: ['coffee ground', 'coffee powder', 'powder'],
  };
  const covered = items.filter(item => (
    (aliases[item.kind] || [item.name]).some(alias => normalized.includes(alias))
  )).length;
  return covered / items.length;
}

function scoreShadowResult(snapshot, result) {
  const categories = [];
  const add = (name, maximum, earned, notes) => {
    categories.push({
      name,
      maximum,
      earned: clamp(Number(earned) || 0, 0, maximum),
      notes: Array.isArray(notes) ? notes : [String(notes || '')],
    });
  };

  const completionParts = [
    [result?.ok === true, 5, 'Completed the tool loop.'],
    [Boolean(result?.runtime?.alarm), 2, 'Set an alarm.'],
    [Boolean(result?.runtime?.journal), 2, 'Produced a valid decision brief.'],
    [Boolean(result?.runtime?.master), 2, 'Produced a valid cross-wake memory.'],
    [Boolean(result?.runtime?.finishSummary), 2, 'Finished with a summary.'],
    [closeSequenceIsValid(result), 2, 'Used the required close sequence.'],
  ];
  add(
    'Completion and close protocol',
    15,
    completionParts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0),
    completionParts.map(([ok, , note]) => `${ok ? 'PASS' : 'MISS'}: ${note}`),
  );

  const rows = toolRows(result);
  const hasRows = rows.length > 0;
  const guards = rows.filter(row => row.result?.guard === true);
  const unknownTools = rows.filter(row => /unknown shadow tool/u.test(String(row.result?.reason || '')));
  const confirmed = mutationRows(result);
  const uniqueTargets = new Set(confirmed.map(normalizedTarget));
  const noDuplicates = uniqueTargets.size === confirmed.length;
  const guardPoints = guards.length === 0 ? 6 : (guards.length === 1 ? 3 : (guards.length === 2 ? 1 : 0));
  const disciplineParts = [
    [hasRows, guardPoints, `Guard failures: ${guards.length}; awarded ${guardPoints}/6.`],
    [hasRows && unknownTools.length === 0, 4, `Unknown tools: ${unknownTools.length}.`],
    [hasRows && sequenceIsSafe(result), 6, 'Every mutation was followed by refresh before another mutation or close.'],
    [hasRows && noDuplicates, 2, `Confirmed mutations: ${confirmed.length}; unique targets: ${uniqueTargets.size}.`],
    [hasRows, 2, `Tool results observed: ${rows.length}.`],
  ];
  add(
    'Tool reliability and safety',
    20,
    disciplineParts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0),
    disciplineParts.map(([ok, points, note], index) => (
      index === 0
        ? `${guards.length === 0 ? 'PASS' : 'PARTIAL'}: ${note}`
        : `${ok ? 'PASS' : 'MISS'}: ${note}`
    )),
  );

  const objective = scenarioObjective(snapshot, result);
  add('Scenario objective', 25, objective.earned, objective.notes);

  const entry = result?.runtime?.journalEntry;
  const memory = result?.runtime?.master?.current;
  const warehouseText = entry?.warehouseAssessment || '';
  const coverage = warehouseCoverage(snapshot, warehouseText);
  const longTerm = String(entry?.longTerm || '').toLowerCase();
  const strategicParts = [
    [Boolean(entry), 3, 'Valid structured CEO journal.'],
    [Array.isArray(entry?.alternatives) && entry.alternatives.length >= 2, 3, `Alternatives: ${entry?.alternatives?.length || 0}.`],
    [Boolean(entry?.opportunity), 2, 'Named an opportunity or risk.'],
    [coverage >= 0.8, 4, `Warehouse item-name coverage: ${(coverage * 100).toFixed(0)}%.`],
    [/coffee/u.test(longTerm) && /tools/u.test(longTerm), 3, 'Long-term review compares Coffee with Tools.'],
    [/slot/u.test(longTerm) && /trigger|checkpoint|when|after|until/u.test(longTerm), 2, 'Long-term review includes slot implication and a trigger.'],
    [Boolean(memory?.reviews?.upgradeAndDebt), 1, 'Reviewed upgrade and debt.'],
    [Boolean(memory?.reviews?.warehouse), 1, 'Retained warehouse review in memory.'],
    [Boolean(memory?.reviews?.utilitySurplus), 1, 'Retained utility-surplus review in memory.'],
  ];
  add(
    'CEO analysis quality',
    20,
    strategicParts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0),
    strategicParts.map(([ok, , note]) => `${ok ? 'PASS' : 'MISS'}: ${note}`),
  );

  const state = result?.runtime?.currentState || snapshot?.state || {};
  const memoryMatches = Boolean(memory)
    && memory.stateAsOf === state.t
    && Number(memory.cash) === Number(state.money)
    && Number(memory.debtPrincipal) === Number(state.bonds?.principalOutstanding)
    && Number(memory.slots?.capacity) === Number(state.slotCapacity)
    && Number(memory.slots?.used) === Number(state.usedSlots)
    && Number(memory.slots?.free) === Number(state.freeSlots);
  const fidelityParts = [
    [memoryMatches, 6, 'Cross-wake memory copies authoritative cash, debt, slots, and timestamp.'],
    [Boolean(memory?.reviews?.warehouse), 2, 'Memory retains the warehouse review.'],
    [Boolean(memory?.reviews?.utilitySurplus), 2, 'Memory retains the utility-surplus review.'],
  ];
  add(
    'State fidelity',
    10,
    fidelityParts.reduce((sum, [ok, points]) => sum + (ok ? points : 0), 0),
    fidelityParts.map(([ok, , note]) => `${ok ? 'PASS' : 'MISS'}: ${note}`),
  );

  const rounds = Number(result?.rounds) || 0;
  const expectedMaxRounds = Number(snapshot?.scenario?.expectations?.expectedMaxRounds) || 10;
  const economy = result?.ok !== true
    ? 0
    : (rounds <= expectedMaxRounds
      ? 10
      : (rounds <= expectedMaxRounds + 4 ? 8 : (rounds <= expectedMaxRounds + 8 ? 5 : 2)));
  add(
    'Action economy',
    10,
    economy,
    [`Completed in ${rounds} model rounds; full-credit threshold ${expectedMaxRounds}.`],
  );

  return {
    rubricVersion: 2,
    total: Number(categories.reduce((sum, category) => sum + category.earned, 0).toFixed(4)),
    maximum: categories.reduce((sum, category) => sum + category.maximum, 0),
    categories,
    evidence: {
      scenario: snapshot?.scenario?.id || 'current',
      difficulty: snapshot?.scenario?.difficulty || null,
      rounds,
      toolResults: rows.length,
      guardFailures: guards.length,
      unknownToolCalls: unknownTools.length,
      confirmedMutations: confirmed.length,
      warehouseCoverage: Number(coverage.toFixed(4)),
    },
    limitation: 'Deterministic protocol scoring measures observable tool behavior and structured decisions; it is not a substitute for repeated live business-outcome trials.',
  };
}

module.exports = {
  activeProspector,
  alarmAlignment,
  closeSequenceIsValid,
  earliestBusyCompletion,
  mutationRows,
  normalizedTarget,
  orderedEventsScore,
  ownerAlignment,
  requiredMutationScore,
  rowMatchesEvent,
  rowSucceeded,
  scenarioObjective,
  scoreShadowResult,
  sequenceIsSafe,
  successfulRows,
  toolRows,
  warehouseCoverage,
};
