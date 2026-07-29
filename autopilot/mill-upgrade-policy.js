'use strict';

// Upgrade merit is intentionally independent of current cash. Financing is evaluated only after
// the economically preferred next step is known. Pareto dominance avoids hiding business tradeoffs
// behind arbitrary weights: a candidate wins deterministically only when it is no worse on every
// measured dimension and strictly better on at least one.

const EPSILON = 1e-9;
const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;

function requireFinitePositive(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

function normalizeCandidate(candidate, {
  nowMs = Date.now(),
  maxEvidenceAgeSeconds = DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
} = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('candidate must be an object');
  }

  const buildingId = Number(candidate.buildingId);
  const currentLevel = Number(candidate.currentLevel);
  if (!Number.isSafeInteger(buildingId) || buildingId <= 0) throw new Error('buildingId must be a positive integer');
  if (!Number.isInteger(currentLevel) || currentLevel < 1 || currentLevel >= 3) {
    throw new Error('currentLevel must be an integer below the L3 target');
  }

  const currentRate = requireFinitePositive(candidate.currentRate, 'currentRate');
  const productionIncreasePct = requireFinitePositive(candidate.productionIncreasePct, 'productionIncreasePct');
  const cashCost = requireFinitePositive(candidate.cashCost, 'cashCost');
  const downtimeHours = requireFinitePositive(candidate.downtimeHours, 'downtimeHours');
  const evidenceAsOf = String(candidate.evidenceAsOf || '');
  const evidenceMs = Date.parse(evidenceAsOf);
  const now = Number(nowMs);
  const maxAge = Number(maxEvidenceAgeSeconds);
  if (!evidenceAsOf || !Number.isFinite(evidenceMs)) {
    throw new Error('evidenceAsOf must be a valid timestamp');
  }
  if (!Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error('evidence freshness options are invalid');
  }
  const evidenceAgeSeconds = (now - evidenceMs) / 1000;
  if (evidenceAgeSeconds < -MAX_FUTURE_SKEW_SECONDS || evidenceAgeSeconds > maxAge) {
    throw new Error('evidenceAsOf must be fresh and cannot be in the future');
  }

  const addedRate = currentRate * productionIncreasePct / 100;
  return {
    buildingId,
    currentLevel,
    nextLevel: currentLevel + 1,
    currentRate,
    nextRate: currentRate + addedRate,
    addedRate,
    productionIncreasePct,
    cashCost,
    downtimeHours,
    downtimeOutputLoss: currentRate * downtimeHours,
    costPerAddedRate: cashCost / addedRate,
    evidenceAsOf: new Date(evidenceMs).toISOString(),
    evidenceAgeSeconds: Math.round(evidenceAgeSeconds),
  };
}

function noWorse(candidate, other) {
  return candidate.addedRate + EPSILON >= other.addedRate
    && candidate.cashCost <= other.cashCost + EPSILON
    && candidate.downtimeHours <= other.downtimeHours + EPSILON
    && candidate.downtimeOutputLoss <= other.downtimeOutputLoss + EPSILON;
}

function strictlyBetter(candidate, other) {
  return candidate.addedRate > other.addedRate + EPSILON
    || candidate.cashCost + EPSILON < other.cashCost
    || candidate.downtimeHours + EPSILON < other.downtimeHours
    || candidate.downtimeOutputLoss + EPSILON < other.downtimeOutputLoss;
}

function dominates(candidate, other) {
  return noWorse(candidate, other) && strictlyBetter(candidate, other);
}

function compareMillUpgradeCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 3) {
    throw new Error('candidates must contain two or three Mill upgrades');
  }

  const evaluated = candidates.map(candidate => normalizeCandidate(candidate, options));
  if (new Set(evaluated.map(candidate => candidate.buildingId)).size !== evaluated.length) {
    throw new Error('candidate buildingIds must be unique');
  }

  const results = evaluated.map(candidate => {
    const dominatesIds = evaluated
      .filter(other => other.buildingId !== candidate.buildingId && dominates(candidate, other))
      .map(other => other.buildingId);
    const dominatedByIds = evaluated
      .filter(other => other.buildingId !== candidate.buildingId && dominates(other, candidate))
      .map(other => other.buildingId);
    return { ...candidate, dominates: dominatesIds, dominatedBy: dominatedByIds };
  });
  const frontierBuildingIds = results
    .filter(candidate => candidate.dominatedBy.length === 0)
    .map(candidate => candidate.buildingId);

  return {
    ok: true,
    financingConsidered: false,
    method: 'pareto-added-rate-cost-downtime-output-loss',
    candidates: results,
    frontierBuildingIds,
    recommendedBuildingId: frontierBuildingIds.length === 1 ? frontierBuildingIds[0] : null,
    requiresJudgment: frontierBuildingIds.length !== 1,
  };
}

module.exports = {
  compareMillUpgradeCandidates,
  dominates,
  normalizeCandidate,
};
