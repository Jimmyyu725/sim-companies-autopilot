'use strict';

function resolvePointer(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { ok: false, error: 'pointer must begin with /' };
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(raw)) return { ok: false, error: `invalid JSON Pointer escape: ${pointer}` };
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { ok: false, error: `evidence pointer not found: ${pointer}` };
    }
    current = current[token];
  }
  return { ok: true, value: current };
}

const ROLE_PREFIXES = Object.freeze({
  CFO: Object.freeze(['/decisionModel', '/company', '/debt', '/financePage', '/statements']),
  COO: Object.freeze(['/decisionModel', '/slots', '/buildings', '/warehouse', '/stock', '/modifiers', '/printedRates', '/buildingInspection', '/portfolioInspections']),
  CMO: Object.freeze(['/decisionModel', '/groceryRetailEvidence', '/weather', '/retail', '/keyPrices', '/volume1h', '/volume1hMeta', '/marketBooks']),
});

function pointerWithin(pointer, prefix) {
  return pointer === prefix || pointer.startsWith(`${prefix}/`);
}

function sourceFresh(evidence, key, acceptedStatuses = ['ok'], maxAgeSeconds = 180) {
  const source = evidence?.sourceStatus?.[key];
  if (!source || !acceptedStatuses.includes(source.status)) return false;
  const collectedAtMs = Date.parse(evidence?.meta?.collectedAt);
  const asOfMs = Date.parse(source.asOf);
  if (!Number.isFinite(collectedAtMs) || !Number.isFinite(asOfMs)) return false;
  const ageSeconds = Math.round((collectedAtMs - asOfMs) / 1000);
  return ageSeconds >= -30 && ageSeconds <= maxAgeSeconds;
}

function stateMetricAuthority(pointer, evidence) {
  if (evidence?.meta?.stateFreshness !== 'FRESH') return false;
  if (pointerWithin(pointer, '/strategyCandidates')) {
    const tokens = pointer.split('/');
    const index = Number(tokens[2]);
    const candidate = Number.isSafeInteger(index) ? evidence?.strategyCandidates?.[index] : null;
    const previewPrefix = `/strategyCandidates/${index}/preview`;
    return evidence?.meta?.strategyCandidates === 'VERIFIED' &&
      candidate?.source === 'runtime-verified-structural-preview' &&
      candidate?.preview?.ok === true &&
      (candidate?.preview?.preview === true || candidate?.preview?.dry === true) &&
      pointerWithin(pointer, previewPrefix) &&
      Number.isFinite(candidate?.previewAgeSeconds) &&
      candidate.previewAgeSeconds >= -30 &&
      candidate.previewAgeSeconds <= 600;
  }
  if (pointerWithin(pointer, '/authorizationPreview')) {
    const preview = evidence?.authorizationPreview;
    return evidence?.meta?.authorizationPreview === 'VERIFIED' &&
      preview?.source === 'runtime-verified-structural-preview' &&
      preview?.preview?.ok === true &&
      (preview?.preview?.preview === true || preview?.preview?.dry === true) &&
      pointerWithin(pointer, '/authorizationPreview/preview') &&
      Number.isFinite(preview?.previewAgeSeconds) &&
      preview.previewAgeSeconds >= -30 &&
      preview.previewAgeSeconds <= 600;
  }
  if (pointerWithin(pointer, '/company')) return sourceFresh(evidence, 'auth');
  if (pointerWithin(pointer, '/debt')) return sourceFresh(evidence, 'bonds');
  if (pointerWithin(pointer, '/slots')) return sourceFresh(evidence, 'auth') && sourceFresh(evidence, 'buildings');
  if (pointerWithin(pointer, '/buildings')) return sourceFresh(evidence, 'buildings');
  if (pointerWithin(pointer, '/warehouse') || pointerWithin(pointer, '/stock')) {
    return sourceFresh(evidence, 'stock') && evidence?.warehouse?.complete === true
      && evidence?.warehouse?.allPositiveProductsIncluded === true;
  }
  if (pointerWithin(pointer, '/modifiers')) return sourceFresh(evidence, 'modifiers');
  if (pointerWithin(pointer, '/printedRates')) return sourceFresh(evidence, 'printedRates', ['fresh'], 6 * 3600);
  if (pointerWithin(pointer, '/weather')) return sourceFresh(evidence, 'weather');
  if (pointerWithin(pointer, '/retail')) return sourceFresh(evidence, 'retail');
  if (pointerWithin(pointer, '/keyPrices')) return sourceFresh(evidence, 'ticker', ['ok', 'mixed', 'fallback'], 600);
  if (pointerWithin(pointer, '/volume1h') || pointerWithin(pointer, '/volume1hMeta')) {
    return sourceFresh(evidence, 'volume1h', ['ok'], 600);
  }
  return null;
}

function metricIsAuthoritative(pointer, evidence) {
  const stateAuthority = stateMetricAuthority(pointer, evidence);
  if (stateAuthority !== null) return stateAuthority;
  if (pointerWithin(pointer, '/decisionModel')) {
    if (evidence?.meta?.stateFreshness !== 'FRESH' ||
        evidence?.meta?.portfolioInspection !== 'OK' ||
        evidence?.decisionModel?.status !== 'COMPLETE') return false;
    if (pointerWithin(pointer, '/decisionModel/candidateComparison')) {
      const index = Number(pointer.split('/')[3]);
      const row = Number.isSafeInteger(index)
        ? evidence?.decisionModel?.candidateComparison?.[index]
        : null;
      return row?.evidenceStatus === 'MEASURED_BASELINE' ||
        row?.evidenceStatus === 'MEASURED_WITH_LINEAR_LEVEL_PROJECTION';
    }
    if (pointerWithin(pointer, '/decisionModel/coffeeChain/retailEvidence') ||
        pointerWithin(pointer, '/decisionModel/coffeeChain/current/retail')) {
      return ['ACTIVE_ORDER', 'LIVE_CURVE'].includes(
        evidence?.decisionModel?.coffeeChain?.retailEvidence?.status);
    }
    if (pointerWithin(pointer, '/decisionModel/coffeeChain/warehouseAvailable')) {
      return evidence?.meta?.warehouseComplete === true;
    }
    return [
      '/decisionModel/coffeeChain/current',
      '/decisionModel/coffeeChain/afterKnownProductionModifiers',
      '/decisionModel/coffeeChain/currentFarmAllocation',
      '/decisionModel/coffeeChain/modifierExpiries',
    ].some(prefix => pointerWithin(pointer, prefix));
  }
  if (pointerWithin(pointer, '/portfolioInspections')) {
    const index = Number(pointer.split('/')[2]);
    const row = Number.isSafeInteger(index) ? evidence?.portfolioInspections?.[index] : null;
    return evidence?.meta?.portfolioInspection === 'OK' && row?.ok === true && row?.fresh === true;
  }
  if (pointerWithin(pointer, '/groceryRetailEvidence')) {
    return evidence?.meta?.stateFreshness === 'FRESH' &&
      ['ACTIVE_ORDER', 'LIVE_CURVE'].includes(evidence?.groceryRetailEvidence?.status);
  }
  if (pointerWithin(pointer, '/financePage')) return Number(evidence?.financePage?.status) === 200;
  if (pointerWithin(pointer, '/buildingInspection')) {
    return evidence?.meta?.buildingInspection === 'OK' && evidence?.buildingInspection?.ok === true;
  }
  if (pointerWithin(pointer, '/statements')) {
    const statementName = pointer.split('/')[2];
    return Boolean(statementName) && Number(evidence?.statements?.[statementName]?.status) === 200;
  }
  if (pointerWithin(pointer, '/marketBooks')) {
    const index = Number(pointer.split('/')[2]);
    const book = Number.isSafeInteger(index) ? evidence?.marketBooks?.[index] : null;
    return Number(book?.status) === 200 && book?.freshness === 'FRESH'
      && Number.isFinite(book?.ageSeconds) && book.ageSeconds >= -30 && book.ageSeconds <= 600;
  }
  return false;
}

function samePrimitive(left, right) {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  return ['string', 'number', 'boolean'].includes(typeof left) && Object.is(left, right);
}

function validateCouncilVote(role, vote, evidence) {
  try {
    if (!vote || typeof vote !== 'object' || Array.isArray(vote)) throw new Error('vote is not an object');
    if (!['APPROVE', 'AMEND', 'REJECT', 'UNKNOWN'].includes(vote.verdict)) throw new Error('invalid verdict');
    for (const field of ['summary', 'unknowns', 'conditions']) {
      const values = field === 'summary' ? [vote[field]] : vote[field];
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${field} has invalid type`);
      if (values.some(value => /\d/.test(value))) throw new Error(`${field} must not contain numeric claims; cite them through metrics`);
    }
    if (!Array.isArray(vote.metrics) || vote.metrics.length < 1 || vote.metrics.length > 8) {
      throw new Error('metrics must contain one to eight evidence citations');
    }
    let hasRoleEvidence = false;
    const metrics = vote.metrics.map(metric => {
      if (!metric || typeof metric.pointer !== 'string') throw new Error('metric pointer missing');
      const resolved = resolvePointer(evidence, metric.pointer);
      if (!resolved.ok) throw new Error(resolved.error);
      if (!samePrimitive(resolved.value, metric.value)) {
        throw new Error(`metric value does not match evidence at ${metric.pointer}`);
      }
      const isRoleEvidence = (ROLE_PREFIXES[role] || []).some(prefix => pointerWithin(metric.pointer, prefix));
      const isStrategyCandidate = pointerWithin(metric.pointer, '/strategyCandidates');
      const isAuthorizationPreview = pointerWithin(
        metric.pointer, '/authorizationPreview');
      if (isStrategyCandidate && !metricIsAuthoritative(metric.pointer, evidence)) {
        throw new Error(`strategy candidate metric is not authoritative at ${metric.pointer}`);
      }
      if (isAuthorizationPreview && !metricIsAuthoritative(metric.pointer, evidence)) {
        throw new Error(`authorization preview metric is not authoritative at ${metric.pointer}`);
      }
      if (vote.verdict !== 'UNKNOWN' && isRoleEvidence && !metricIsAuthoritative(metric.pointer, evidence)) {
        throw new Error(`metric is not authoritative at ${metric.pointer}`);
      }
      hasRoleEvidence ||= isRoleEvidence && metricIsAuthoritative(metric.pointer, evidence);
      return { pointer: metric.pointer, value: resolved.value };
    });
    if (vote.verdict !== 'UNKNOWN' && !hasRoleEvidence) {
      throw new Error(`${role} vote lacks an authoritative role-specific metric`);
    }
    return {
      ok: true,
      value: {
        role,
        status: 'VALIDATED',
        verdict: vote.verdict,
        summary: vote.summary.trim(),
        metrics,
        unknowns: vote.unknowns.map(value => value.trim()),
        conditions: vote.conditions.map(value => value.trim()),
      },
    };
  } catch (error) {
    return {
      ok: false,
      value: {
        role,
        status: 'INVALID_EVIDENCE',
        verdict: 'UNKNOWN',
        summary: 'Council output failed deterministic evidence validation.',
        metrics: [],
        unknowns: [String(error.message || error)],
        conditions: [],
      },
    };
  }
}

function invalidStrategyVote(role, error) {
  return {
    ok: false,
    value: {
      role,
      status: 'INVALID_EVIDENCE',
      verdict: 'UNKNOWN',
      optionId: null,
      summary: 'Strategy council output failed deterministic evidence validation.',
      metrics: [],
      unknowns: [String(error?.message || error)],
      conditions: [],
    },
  };
}

function validateStrategyCouncilVote(role, vote, evidence, optionIds) {
  try {
    if (!vote || typeof vote !== 'object' || Array.isArray(vote)) {
      throw new Error('vote is not an object');
    }
    if (!['RECOMMEND', 'UNKNOWN'].includes(vote.verdict)) {
      throw new Error('invalid strategy verdict');
    }
    const allowedOptions = new Set(
      (Array.isArray(optionIds) ? optionIds : [])
        .map(value => String(value || '').trim())
        .filter(Boolean),
    );
    const optionId = vote.optionId == null ? null : String(vote.optionId).trim();
    if (vote.verdict === 'RECOMMEND' && (!optionId || !allowedOptions.has(optionId))) {
      throw new Error('recommended strategy option is not in the supplied option set');
    }
    if (vote.verdict === 'UNKNOWN' && optionId !== null) {
      throw new Error('UNKNOWN strategy vote must use a null optionId');
    }
    const validated = validateCouncilVote(role, {
      verdict: vote.verdict === 'RECOMMEND' ? 'APPROVE' : 'UNKNOWN',
      summary: vote.summary,
      metrics: vote.metrics,
      unknowns: vote.unknowns,
      conditions: vote.conditions,
    }, evidence);
    if (!validated.ok) return invalidStrategyVote(role, validated.value?.unknowns?.[0]);
    return {
      ok: true,
      value: {
        ...validated.value,
        verdict: vote.verdict,
        optionId,
      },
    };
  } catch (error) {
    return invalidStrategyVote(role, error);
  }
}

const councilVoteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'AMEND', 'REJECT', 'UNKNOWN'] },
    summary: { type: 'string', maxLength: 600, description: 'Qualitative rationale only. Do not include digits or numeric claims.' },
    metrics: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          pointer: { type: 'string', description: 'RFC 6901 pointer into the supplied automatic evidence.' },
          value: { type: ['string', 'number', 'boolean', 'null'] },
        },
        required: ['pointer', 'value'],
      },
    },
    unknowns: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 }, description: 'Qualitative only; no digits.' },
    conditions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 }, description: 'Qualitative only; no digits.' },
  },
  required: ['verdict', 'summary', 'metrics', 'unknowns', 'conditions'],
};

const strategyCouncilVoteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['RECOMMEND', 'UNKNOWN'] },
    optionId: {
      type: ['string', 'null'],
      maxLength: 80,
      description: 'Exact supplied option ID for RECOMMEND; null for UNKNOWN.',
    },
    summary: {
      type: 'string',
      maxLength: 600,
      description: 'Qualitative rationale only. Do not include digits or numeric claims.',
    },
    metrics: councilVoteSchema.properties.metrics,
    unknowns: councilVoteSchema.properties.unknowns,
    conditions: councilVoteSchema.properties.conditions,
  },
  required: ['verdict', 'optionId', 'summary', 'metrics', 'unknowns', 'conditions'],
};

module.exports = {
  councilVoteSchema,
  metricIsAuthoritative,
  resolvePointer,
  strategyCouncilVoteSchema,
  validateCouncilVote,
  validateStrategyCouncilVote,
};
