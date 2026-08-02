#!/usr/bin/env node
// autopilot/act.js — the LLM brain's execution toolkit. ONE command = ONE action, and every action
// does navigate → set-param → run-primitive inside a SINGLE cdp session. LESSONS.md B5: never split
// a browser navigate+act across separate flock commands, or another process moves the shared tab in
// the gap. The brain decides WHAT (produce/buy/build/sell); these proven actions/*.js primitives — the
// exact ones the (archived) fast loop used all night — do the HOW.
//
// Usage (ALWAYS wrap in the tick lock):  flock -w 60 .tick.lock node autopilot/act.js <action> '<json>'
//   collect                                            -> collect all finished output + cash
//   produce '{"buildingId":123,"name":"COFFEE POWDER","qty":300,"targetHours":null,"finishBefore":null}'
//   (`qty` is the business amount; duration/checkpoint caps never inflate qty.)
//   buy     '{"kind":2,"maxSpend":500,"ask":0.4}'      -> buy an input on the market
//   build   '{"building":"Bakery","maxCost":42000,"minCashAfter":4000,"confirm":true}'
//   upgrade '{"buildingId":123,"confirm":true}'
//   sell    '{"buildingId":<storeId>,"name":"COFFEE POWDER","qty":100,"price":45}'  (retail store order)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const AUTOPILOT = __dirname;
const DIR = path.dirname(AUTOPILOT);
const SHARED = path.join(DIR, 'shared');
const ACTIONS = path.join(AUTOPILOT, 'actions');
const REFERENCE = path.join(AUTOPILOT, 'reference');
const cdp = require(path.join(SHARED, 'cdp.js'));
const CFG = require(path.join(SHARED, 'config.json'));
const {
  CHAT_ROOMS,
  validateActionParams,
} = require(path.join(AUTOPILOT, 'action-contracts.js'));
const {
  authorizeChatAction,
  resolveChatMode,
} = require(path.join(AUTOPILOT, 'chat', 'runtime-mode.js'));
const {
  evaluatePublicSend,
  inspectOutgoingText,
} = require(path.join(AUTOPILOT, 'chat', 'policy.js'));
const {
  consumeCommunicationAuthorization,
  inspectCommunicationAuthorization,
  recordCommunicationOutcome,
  requiresEconomicCommunicationAuthorization,
} = require(path.join(AUTOPILOT, 'chat', 'communication-authorization.js'));
const {
  buildPublicPostPlan,
  replyPrefix,
} = require(path.join(AUTOPILOT, 'chat', 'public-ui.js'));
const {
  appendPublicHistory,
  claimPublicAttempt,
  readPublicHistory,
} = require(path.join(AUTOPILOT, 'chat', 'public-history.js'));
const {
  PrivateSendOutbox,
  canonicalPrivateCompany,
  canonicalPrivateMessageText,
  canonicalSourceText,
  runDurablePrivateSendAttempt,
} = require(path.join(AUTOPILOT, 'chat', 'private-outbox.js'));
const { ActiveChatStore } = require(path.join(AUTOPILOT, 'chat', 'active-store.js'));
const {
  chooseBestRetailQuote,
  coarsePriceCandidates,
  finePriceCandidates,
  parseRetailQuote,
} = require(path.join(AUTOPILOT, 'retail-optimizer.js'));
const {
  buildMillBatchPolicy,
  buildProductionPolicyPagePrelude,
  evaluateBridgeUtilitySurplusGuard,
  evaluateMillBatchGuard,
  parseProductionCheckpoint,
  resolveProductionResourceIdentity,
  resolveTargetHours,
} = require(path.join(AUTOPILOT, 'production-policy.js'));
const {
  buildProductionCardBindingPagePrelude,
} = require(path.join(AUTOPILOT, 'production-card-binding.js'));
const {
  validateFreshSaleInspection,
  validateFreshSurplus,
} = require(path.join(AUTOPILOT, 'exchange-sale-safety.js'));
const {
  consumeInspectionArtifact,
  readInspectionArtifact,
} = require(path.join(AUTOPILOT, 'exchange-sale-inspection-store.js'));
const {
  markOwnerBridgeStarted,
  PROSPECTOR_OVERVIEW_PATH,
  isOwnerProspectorCampaignTarget,
  readPendingOwnerDirective,
  recordOwnerProspectorBuildTarget,
  recordOwnerProspectorRebuildOutcome,
  refreshAndClaimOwnerProspectorRebuildAttempt,
} = require(path.join(AUTOPILOT, 'owner-directive.js'));
const {
  bondOfferMatches,
  buildingHasRobotSpecialization,
  buildingHasBusyResource,
  capturedCashSnapshot,
  evaluateSpendGuard,
  explicitFiniteNumber,
  parseExplicitCurrency,
  planExactMarketPurchase,
  planMarketPurchase,
  quoteFixedMarketPurchase,
  validateRebuildIdleEvidence,
  verifyBuildingRemoved,
  verifyBuildingRebuildStarted,
  verifyBuildingUpgradeStarted,
  verifyCollectionResult,
  verifyNewBuildingStarted,
} = require(path.join(AUTOPILOT, 'action-verification.js'));
const {
  buildPaReview,
  buildPendingPa,
  clearPaReview,
  clearPendingPa,
  matchUniqueOption,
  normalizeText,
  readPaReview,
  readPendingPa,
  writePaReview,
  writePaStatus,
  writePendingPa,
} = require(path.join(AUTOPILOT, 'pa-state.js'));
const {
  consultPaGuides,
} = require(path.join(AUTOPILOT, 'pa-guide.js'));
const page = (f) => fs.readFileSync(path.join(ACTIONS, f), 'utf8');
const B = (id) => `https://www.simcompanies.com/b/${id}/`;
const PA_PENDING_FILE = path.join(AUTOPILOT, '.pa-pending.json');
const PA_REVIEW_FILE = path.join(AUTOPILOT, '.pa-review.json');
const PA_STATUS_FILE = path.join(AUTOPILOT, '.pa-status.json');
const PA_HISTORY_FILE = path.join(AUTOPILOT, 'pa-history.jsonl');

function phaseAttemptId(attemptId, phase) {
  const digest = crypto.createHash('sha256')
    .update(`${String(attemptId)}\u0000${String(phase)}`)
    .digest('hex')
    .slice(0, 32);
  return `ui:${digest}`;
}
const [action, json] = process.argv.slice(2);
let rawParams = {};
try {
  rawParams = json ? JSON.parse(json) : {};
} catch (error) {
  console.log(JSON.stringify({ ok: false, guard: true,
    reason: `action parameters are not valid JSON: ${String(error.message || error).slice(0, 180)}` }));
  process.exit(0);
}
const checked = validateActionParams(action, rawParams);
if (!checked.ok) {
  console.log(JSON.stringify({ ok: false, guard: true, reason: checked.reason }));
  process.exit(0);
}
const p = checked.params;
const CHAT_MODE = resolveChatMode();
const chatAuthorization = authorizeChatAction(action, p, CHAT_MODE);
if (!chatAuthorization.ok) {
  console.log(JSON.stringify(chatAuthorization));
  process.exit(0);
}
let retailMinPrice = null;
let exchangeSaleContext = null;
let ownerBridgeAuthorization = null;
let productionCheckpoint = null;
let productionResourceIdentity = null;
let chatPublicPlan = null;
let chatPublicParts = null;
let chatPrivateOutbox = null;
let chatPrivateAttempt = null;
let chatEconomicAuthorization = null;
const BUILDINGS_API = '/api/v2/companies/me/buildings/';
const AUTH_API = '/api/v3/companies/auth-data/';
const RESOURCES_API = `/api/v3/resources/${CFG.companyId}/`;

async function captureBuildings(url) {
  try {
    const captured = await cdp.capture(url, 15);
    const rows = captured?.[BUILDINGS_API];
    return Array.isArray(rows) ? rows : null;
  } catch (error) {
    return null;
  }
}

async function captureRebuildIdleEvidence(beforeBuilding, buildingId) {
  const base = {
    buildingId: Number(buildingId),
    buildingName: beforeBuilding?.name || null,
    level: Number(beforeBuilding?.size),
    observedAt: new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(beforeBuilding || {}, 'busy')) {
    return validateRebuildIdleEvidence(beforeBuilding, {
      ...base,
      source: 'authoritative-api',
    });
  }
  const pageEvidence = await cdp.evaluate(String.raw`
    const text = norm(document.body.innerText);
    const openers = all('button').filter(button => button.offsetParent !== null &&
      /^REBUILD$/i.test(norm(button.innerText)));
    const levelMatch = text.match(/LEVEL\s+(\d+)/i);
    return {
      path: location.pathname,
      pageLevel: levelMatch ? Number(levelMatch[1]) : null,
      construction: /(?:currently upgrading|upgrading to level|under construction|construction\s+finishes|cannot take any orders until the upgrade is finished)/i.test(text),
      orderBusy: /currently busy/i.test(text),
      collectible: all('button').some(button => button.offsetParent !== null && !button.disabled &&
        /^(?:COLLECT|COLLECT ALL)(?:\b|$)/i.test(norm(button.innerText))),
      orderAvailable: all('div').some(div => div.offsetParent !== null &&
        /\bPRODUCTION\b/i.test(norm(div.innerText)) &&
        [...div.querySelectorAll('input')].some(input => input.offsetParent !== null && !input.disabled)),
      rebuildOpenerCount: openers.length,
      rebuildOpenerEnabled: openers.length === 1 && !openers[0].disabled,
    };
  `);
  return validateRebuildIdleEvidence(beforeBuilding, {
    ...base,
    ...pageEvidence,
    level: pageEvidence?.pageLevel,
    source: 'page-derived',
    observedAt: new Date().toISOString(),
  });
}

async function captureCollectSnapshot(url) {
  try {
    const captured = await cdp.capture(url, 15);
    const buildings = captured?.[BUILDINGS_API];
    const resources = captured?.[RESOURCES_API];
    const auth = captured?.[AUTH_API];
    const money = explicitFiniteNumber(auth?.money ?? auth?.authCompany?.money);
    if (!Array.isArray(buildings) || !Array.isArray(resources) || money == null) return null;
    return { buildings, resources, money };
  } catch (error) {
    return null;
  }
}

function pendingOwnerDirective() {
  return readPendingOwnerDirective(
    path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
    path.join(AUTOPILOT, '.state.json'),
  );
}

function latestCapturedCompanyLevel() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(AUTOPILOT, '.state.json'), 'utf8'));
    const level = Number(state.level);
    return Number.isFinite(level) ? level : null;
  } catch (e) {
    return null;
  }
}

function latestCapturedState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUTOPILOT, '.state.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function latestCapturedCash() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(AUTOPILOT, '.state.json'), 'utf8'));
    return capturedCashSnapshot(state);
  } catch (e) {
    return { value: null, source: null, asOf: null, ageSeconds: null };
  }
}

async function exactCashSnapshot() {
  try {
    const live = await cdp.evaluate(`const r=await api('/api/v3/companies/auth-data/'); return {status:r.status,json:r.json};`);
    const rawValue = live?.json?.money ?? live?.json?.authCompany?.money;
    const value = explicitFiniteNumber(rawValue);
    if (live?.status === 200 && Number.isFinite(value)) {
      return { value, source: '/api/v3/companies/auth-data/', asOf: new Date().toISOString(), ageSeconds: 0 };
    }
  } catch (e) {}
  return latestCapturedCash();
}

async function captureOwnerProspectorOverview() {
  try {
    const live = await cdp.evaluate(`const r=await api(${JSON.stringify(PROSPECTOR_OVERVIEW_PATH)}); return {status:r.status,json:r.json};`);
    return {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: live?.status ?? null,
      fetchedAt: new Date().toISOString(),
      data: live?.json ?? null,
    };
  } catch (_) {
    return {
      path: PROSPECTOR_OVERVIEW_PATH,
      status: null,
      fetchedAt: new Date().toISOString(),
      data: null,
    };
  }
}

// ---- Hardening (2026-07-25 first-live-wake audit). Validate BEFORE touching the browser. ----
// The game has TWO name spaces: exchange/ticker names ("coffee ground", kind 119) and the
// building-dialog CARD names ("COFFEE POWDER"). state.js stock names are exchange names;
// produce.js/sell.js match card names. Canonicalize so the model may pass either.
const DIALOG_NAME = {
  'coffee ground': 'COFFEE POWDER', 'coffee-ground': 'COFFEE POWDER',
  'coffee powder': 'COFFEE POWDER', 'coffee-powder': 'COFFEE POWDER', 'powder': 'COFFEE POWDER',
  'coffee beans': 'COFFEE BEANS', 'coffee-beans': 'COFFEE BEANS', 'beans': 'COFFEE BEANS',
  'grape': 'GRAPES', 'apple': 'APPLES', 'orange': 'ORANGES', 'sausage': 'SAUSAGES',
};
const KIND_OF = { 'COFFEE POWDER': 119, 'COFFEE BEANS': 118, STEAK: 7, SAUSAGES: 8,
                  GRAPES: 5, APPLES: 3, ORANGES: 4, SEEDS: 66 };
const canonName = (n) => { const s = String(n || '').trim().toLowerCase();
  return DIALOG_NAME[s] || s.toUpperCase(); };

// Latest exchange price from the price collector's 2-min ticker dump — no browser needed.
function latestExchange(kind) {
  try {
    const rows = fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'prices.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(rows[rows.length - 1]);
    const ageSeconds = Date.now() / 1000 - Number(last.t);
    if (Number.isFinite(ageSeconds) && ageSeconds >= -30 && ageSeconds < 3600
        && last.p && Number(last.p[kind]) > 0) return Number(last.p[kind]);
  } catch (e) { /* tracker absent -> config fallback below */ }
  return null;
}

function exchangeKindFromName(name) {
  const wanted = String(name || '').trim().toLowerCase().replace(/-/g, ' ');
  try {
    const names = JSON.parse(fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'names.json'), 'utf8'));
    const hit = Object.entries(names).find(([, candidate]) => String(candidate).trim().toLowerCase() === wanted);
    if (hit) return Number(hit[0]);
  } catch (e) {}
  try {
    const defs = JSON.parse(fs.readFileSync(path.join(SHARED, 'facts', 'defs.json'), 'utf8'));
    const hit = Object.entries(defs.resources || {}).find(([, resource]) => {
      const slug = String(resource?.image || '').split('/').pop().replace(/\.png$/i, '').replace(/-/g, ' ').toLowerCase();
      return slug === wanted;
    });
    if (hit) return Number(hit[0]);
  } catch (e) {}
  return null;
}

function uiPublicParts(parts) {
  return parts.map(part => part.type === 'text'
    ? { type: 'text', value: part.value }
    : { type: 'resource', kind: part.kind, ...(part.name == null ? {} : { name: part.name }) });
}

function recentPublicPosts() {
  try {
    return readPublicHistory(publicPostHistoryFile())
      .filter(entry => entry.status !== 'FAILED_PRE_CLICK')
      .map(({ roomId, text, sentAt }) => ({ roomId, text, sentAt }));
  } catch (error) {
    refuse('public chat history is invalid; posting is disabled until the audit log is repaired', {
      historyError: String(error.message || error).slice(0, 180),
    });
  }
  return [];
}

function publicPostHistoryFile() {
  if (process.env.NODE_ENV === 'test' && process.env.SIM_CHAT_HISTORY_FILE) {
    return path.resolve(process.env.SIM_CHAT_HISTORY_FILE);
  }
  return path.join(AUTOPILOT, '.chat-posts.jsonl');
}

function privateSendOutboxRoot() {
  if (process.env.NODE_ENV === 'test' && process.env.SIM_CHAT_PRIVATE_OUTBOX_ROOT) {
    return path.resolve(process.env.SIM_CHAT_PRIVATE_OUTBOX_ROOT);
  }
  return path.join(AUTOPILOT, '.chat-private-outbox');
}

function communicationAuthorizationFile() {
  if (process.env.NODE_ENV === 'test' && process.env.SIM_CHAT_COMMUNICATION_AUTH_FILE) {
    return path.resolve(process.env.SIM_CHAT_COMMUNICATION_AUTH_FILE);
  }
  return path.join(AUTOPILOT, '.chat-communication-authorizations.json');
}

function activeChatStoreRoot() {
  if (process.env.NODE_ENV === 'test' && process.env.SIM_CHAT_ACTIVE_ROOT) {
    return path.resolve(process.env.SIM_CHAT_ACTIVE_ROOT);
  }
  return path.join(AUTOPILOT, '.chat-active');
}

function consumeWorkerExecutionClaim() {
  const token = process.env.SIM_CHAT_EXECUTION_CLAIM_TOKEN;
  let consumed;
  try {
    const root = activeChatStoreRoot();
    const allowedRoots = process.env.NODE_ENV === 'test'
      ? [path.dirname(root)]
      : undefined;
    const store = new ActiveChatStore(root, { allowedRoots });
    consumed = store.consumeExecutionClaim({
      attemptId: p.attemptId,
      actionName: action,
      actionParams: p,
      token,
      consumedAt: new Date(),
    });
  } catch (_) {
    refuse('worker execution claim is missing, invalid, or unreadable; no chat click is authorized', {
      doNotRetry: true,
      doNotClick: true,
      clickCount: 0,
      mutationAuthorized: false,
    });
  }
  if (consumed?.ok !== true || consumed.durable !== true || consumed.state !== 'CONFIRMING') {
    refuse('worker execution claim was not atomically consumed; no chat click is authorized', {
      doNotRetry: true,
      doNotClick: true,
      clickCount: 0,
      mutationAuthorized: false,
    });
  }
  return consumed;
}

function requireEconomicCommunicationAuthorization(renderedText) {
  if (!requiresEconomicCommunicationAuthorization(action, p, renderedText)) return false;
  let inspected;
  try {
    inspected = inspectCommunicationAuthorization(
      communicationAuthorizationFile(),
      action,
      p,
    );
  } catch (error) {
    refuse('economic communication authorization store is invalid; sending is disabled', {
      authorizationError: String(error.message || error).slice(0, 180),
    });
  }
  if (!inspected.ok) {
    refuse(`economic communication authorization: ${inspected.reason}`, {
      attemptId: p.attemptId,
      doNotRetry: inspected.doNotRetry === true,
    });
  }
  return true;
}

function consumeEconomicCommunicationAuthorization() {
  let consumed;
  try {
    consumed = consumeCommunicationAuthorization(
      communicationAuthorizationFile(),
      action,
      p,
    );
  } catch (error) {
    refuse('economic communication authorization could not be atomically consumed', {
      attemptId: p.attemptId,
      authorizationError: String(error.message || error).slice(0, 180),
    });
  }
  if (!consumed.ok) {
    refuse(`economic communication authorization: ${consumed.reason}`, {
      attemptId: p.attemptId,
      doNotRetry: consumed.doNotRetry === true,
    });
  }
  return consumed;
}

function auditEconomicCommunicationOutcome(result) {
  if (!chatEconomicAuthorization) return result;
  try {
    const outcome = recordCommunicationOutcome(communicationAuthorizationFile(), {
      actionName: action,
      attemptId: p.attemptId,
      commitmentId: chatEconomicAuthorization.commitmentId,
      result,
    });
    return { ...result, economicCommunication: outcome };
  } catch (error) {
    return {
      ...result,
      ok: false,
      mutationAttempted: true,
      ambiguous: true,
      doNotRetry: true,
      reason: 'economic communication outcome could not be durably recorded; never replay this attempt',
      authorizationAuditError: String(error.message || error).slice(0, 180),
    };
  }
}

function appendPublicPost(entry) {
  appendPublicHistory(publicPostHistoryFile(), entry);
}

function auditPublicPostOutcome(result, entry) {
  if (!result) return result;
  let auditEntry = entry;
  if (result.posted === undefined) {
    if (result.sendClicked === true || result.mutationAttempted === true) return result;
    auditEntry = {
      ...entry,
      t: Date.now(),
      verified: false,
      status: 'FAILED_PRE_CLICK',
    };
  }
  try {
    appendPublicPost(auditEntry);
    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      mutationAttempted: true,
      doNotRetry: true,
      auditWriteFailed: true,
      reason: 'the public send outcome cannot be safely audited; never retry this send attempt',
      auditError: String(error.message || error).slice(0, 180),
    };
  }
}

function armPublicPostAttempt({ room, text, attemptId }) {
  const entry = {
    t: Date.now(),
    room,
    text,
    verified: false,
    attemptId,
    status: 'ARMED',
  };
  try {
    const claimed = claimPublicAttempt(publicPostHistoryFile(), entry);
    if (!claimed.ok) refuse(claimed.reason, { attemptId });
    return entry;
  } catch (error) {
    refuse('public send attempt could not be durably armed before browser access', {
      attemptId,
      historyError: String(error.message || error).slice(0, 180),
    });
  }
  return null;
}

function validatePublicPlan(room, parts, reason, prefix = '') {
  let plan;
  try {
    plan = buildPublicPostPlan(uiPublicParts(parts), { replyPrefix: prefix });
  } catch (error) {
    refuse(String(error.message || error));
  }
  const policy = evaluatePublicSend({
    text: plan.finalMarkup,
    roomId: room,
    reason,
    recentPublicMessages: recentPublicPosts(),
  });
  if (!policy.ok) refuse(`public chat policy: ${policy.reason}`, { policy });
  return plan;
}

// A refusal is a RESULT the brain reads and corrects from — print JSON, exit 0, never crash.
function refuse(reason, extra) {
  console.log(JSON.stringify(Object.assign({ ok: false, guard: true, reason }, extra || {})));
  process.exit(0);
}

if (action === 'sell' || action === 'produce') {
  p.name = canonName(p.name);
  // Infer buildingId when omitted: farm goods -> the farm; store sells default to the store below.
  const FARM_GOODS = new Set(['SEEDS', 'COFFEE BEANS', 'GRAPES', 'APPLES', 'ORANGES']);
  if (action === 'produce' && !p.buildingId && FARM_GOODS.has(p.name)) p.buildingId = CFG.farmId;
  if (action === 'produce' && !p.buildingId)
    refuse('produce needs buildingId (farm=' + CFG.farmId + '; mills/others: see state.buildings ids)', { name: p.name });
}
if (action === 'produce') {
  if (!p.name) refuse('produce name must be a non-empty dialog-card name');
  if (!Number.isSafeInteger(p.buildingId) || p.buildingId <= 0)
    refuse('produce buildingId must be a positive integer', { got: p.buildingId });
  if (!Number.isFinite(p.qty) || p.qty <= 0)
    refuse('produce qty must be a positive number', { got: p.qty });
  let productionDefinitions;
  try {
    productionDefinitions = JSON.parse(
      fs.readFileSync(path.join(SHARED, 'facts', 'defs.json'), 'utf8'),
    ).resources;
  } catch (error) {
    refuse('production resource definitions are unavailable; no browser was opened', {
      evidenceError: String(error.message || error).slice(0, 180),
    });
  }
  productionResourceIdentity = resolveProductionResourceIdentity({
    name: p.name,
    knownKinds: KIND_OF,
    lookupKind: exchangeKindFromName,
    resources: productionDefinitions,
  });
  if (!productionResourceIdentity.ok) {
    refuse(productionResourceIdentity.reason, { productionResourceIdentity });
  }
  const directive = pendingOwnerDirective();
  if (isOwnerProspectorCampaignTarget(directive, p.buildingId)) {
    refuse('this building is reserved for the active Prospector target pool and cannot receive production', {
      buildingId: Number(p.buildingId),
      requiredNextStep: 'wait for construction or use the exact owner-authorized REBUILD cycle',
    });
  }
  if (directive?.action === 'fund-and-upgrade-building' &&
      Number(directive.buildingId) === Number(p.buildingId)) {
    const bridge = directive.bridgeProduction;
    const executeNotBeforeMs = Date.parse(directive.executeNotBefore);
    const productMatches = canonName(bridge?.product) === p.name;
    const suppliedCheckpointMs = p.finishBefore == null ? null : Date.parse(p.finishBefore);
    const suppliedCheckpointMatches = suppliedCheckpointMs == null ||
      (Number.isFinite(suppliedCheckpointMs) && Math.abs(suppliedCheckpointMs - executeNotBeforeMs) <= 5000);
    const firstBridgeAllowed = bridge?.status === 'authorized' &&
      Number.isFinite(executeNotBeforeMs) && Date.now() < executeNotBeforeMs &&
      productMatches && suppliedCheckpointMatches &&
      Number.isFinite(Number(bridge.maximumQuantity)) && p.qty <= Number(bridge.maximumQuantity) &&
      Number(p.targetHours) === Number(bridge.targetHours);
    const followupBridgeAllowed = bridge?.status === 'started' && productMatches &&
      p.finishBefore != null && p.ownerUpgradeAttemptVerified === true;
    if (firstBridgeAllowed || followupBridgeAllowed) {
      // A pending upgrade may use only a deadline-bound bridge. The first bridge keeps its
      // owner-specified quantity cap; later bridges are allowed only when financing/evidence still
      // prevents the upgrade and the live deadline policy fills, but never crosses, the next retry.
      if (firstBridgeAllowed && p.finishBefore == null) p.finishBefore = directive.executeNotBefore;
      ownerBridgeAuthorization = {
        directiveId: directive.id,
        repeated: followupBridgeAllowed,
      };
    } else {
      refuse('owner directive reserves this building for the next funded upgrade; if the upgrade cannot start now, use a checkpoint-aligned Coffee Powder bridge with a future finishBefore instead of leaving it idle', {
        ownerDirectiveId: directive.id,
        buildingId: p.buildingId,
        targetLevel: directive.targetLevel,
        requiredNextStep: 'call upgrade for this building first in the current wake; only a verified funding/evidence blocker authorizes produce with finishBefore',
      });
    }
  }
  productionCheckpoint = parseProductionCheckpoint(p.finishBefore, Date.now());
  if (!productionCheckpoint.ok) {
    refuse(productionCheckpoint.reason, {
      finishBefore: p.finishBefore,
      secondsAhead: productionCheckpoint.secondsAhead ?? null,
    });
  }
  p.finishBefore = productionCheckpoint.finishBefore;
  if (ownerBridgeAuthorization) ownerBridgeAuthorization.finishBefore = p.finishBefore;
  if (p.finishBefore != null) {
    let productionFacts;
    try {
      productionFacts = JSON.parse(
        fs.readFileSync(path.join(SHARED, 'facts', 'game-facts.json'), 'utf8'),
      );
    } catch (error) {
      refuse('production recipe facts are unavailable; no browser was opened', {
        evidenceError: String(error.message || error).slice(0, 180),
        suggestedQty: 0,
      });
    }
    const utilityGuard = evaluateBridgeUtilitySurplusGuard({
      name: p.name,
      kind: productionResourceIdentity.kind,
      qty: p.qty,
      finishBefore: p.finishBefore,
      state: latestCapturedState(),
      facts: productionFacts,
      nowMs: Date.now(),
    });
    if (!utilityGuard.ok) refuse(utilityGuard.reason, utilityGuard);
  }
}
if (action === 'sell') {
  p.qty = Number(p.qty); p.price = Number(p.price);
  if (!Number.isFinite(p.qty) || p.qty <= 0) refuse('sell qty must be a positive number', { got: p.qty });
  if (!Number.isFinite(p.price) || p.price <= 0)   // live wake 1 tried price:0 on 84 powder
    refuse('sell price must be a positive $/unit near the retail average — NEVER 0 or blank', { got: p.price });
  const kind = KIND_OF[p.name];
  const exch = kind ? latestExchange(kind) : null;
  const avg = ((CFG.storeProducts || []).find(x => x.name === p.name) || {}).avgPrice || null;
  const ref = exch || avg;
  retailMinPrice = 0.6 * (ref || p.price);
  if (ref && p.price < 0.6 * ref)
    refuse(`sell price $${p.price} is below 60% of the $${ref} reference for ${p.name}; ` +
           'use the current retail average or latest comparable winning price as the scan anchor',
           { exchange: exch, retailAvg: avg, floor: +(0.6 * ref).toFixed(2) });
}
if (action === 'buy') {
  if (typeof p.kind !== 'number') {   // live wake 1 passed kind:"seeds" -> broken market URL
    try {
      const names = JSON.parse(fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'names.json'), 'utf8'));
      const want = String(p.kind || '').trim().toLowerCase().replace(/-/g, ' ');
      const hit = Object.entries(names).find(([, n]) => n === want);
      if (hit) p.kind = Number(hit[0]);
    } catch (e) {}
    if (typeof p.kind !== 'number') refuse('buy kind must be the NUMERIC resource kind (seeds=66, water=2, cow=115, pig=116)', { got: p.kind });
  }
  if (p.quantity == null) p.quantity = null;
  else {
    p.quantity = Number(p.quantity);
    if (!Number.isSafeInteger(p.quantity) || p.quantity <= 0) {
      refuse('buy quantity must be a positive integer or null', { got: p.quantity });
    }
  }
  p.maxSpend = Number(p.maxSpend);
  if (!Number.isFinite(p.maxSpend) || p.maxSpend <= 0) refuse('buy maxSpend must be a positive number', { got: p.maxSpend });
  // buy.js computes `ask = askHint || cheapest-book-price`; a non-numeric truthy ask (live
  // wake 1 sent ask:true) becomes a $1 unit price -> qty = maxSpend UNITS. Drop bad asks.
  if (p.ask != null && (!Number.isFinite(Number(p.ask)) || Number(p.ask) <= 0)) delete p.ask;
  else if (p.ask != null) p.ask = Number(p.ask);
}
if (action === 'inspect_exchange_buy') {
  p.kind = Number(p.kind);
  p.quantity = Number(p.quantity);
  if (!Number.isSafeInteger(p.kind) || p.kind <= 0
      || !Number.isSafeInteger(p.quantity) || p.quantity <= 0) {
    refuse('inspect_exchange_buy needs positive integer kind and quantity', { got: p });
  }
  if (p.maxUnitPrice == null) p.maxUnitPrice = null;
  else {
    p.maxUnitPrice = Number(p.maxUnitPrice);
    if (!Number.isFinite(p.maxUnitPrice) || p.maxUnitPrice <= 0) {
      refuse('inspect_exchange_buy maxUnitPrice must be a positive number or null', {
        got: p.maxUnitPrice,
      });
    }
  }
}
if (action === 'exchange_sell') {
  p.name = String(p.name || '').trim().toLowerCase().replace(/ /g, '-');
  p.qty = Number(p.qty);
  p.price = Number(p.price);
  if (!p.name || !Number.isFinite(p.qty) || p.qty <= 0 || !Number.isFinite(p.price) || p.price <= 0) {
    refuse('exchange_sell needs {name(imgname), qty>0, price>0}', { got: p });
  }
  const kind = exchangeKindFromName(p.name);
  if (!kind) refuse('exchange_sell could not resolve the resource kind from the current resource definitions', { name: p.name });
  // An owner liquidation directive dismantles the chain the surplus plan exists to protect, so the
  // plan can no longer be built and every sale would be refused. Honour the instruction; the rest of
  // the safety checks (warehouse completeness, staleness, Transport) still apply.
  // A separate file: the brain rewrites OWNER-DIRECTIVE.json during a wake and would drop this.
  let ownerLiquidation = false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(AUTOPILOT, 'OWNER-LIQUIDATION.json'), 'utf8'));
    ownerLiquidation = raw?.status === 'pending' && raw?.sellEverythingElse === true;
  } catch (_) { ownerLiquidation = false; }
  const safety = validateFreshSurplus(latestCapturedState(), kind, p.qty, Date.now(), { ownerLiquidation });
  if (!safety.ok) {
    refuse(`exchange_sell surplus guard: ${safety.reason}`, {
      kind,
      requestedQty: p.qty,
      safeSellable: safety.safeSellable ?? null,
      reserve: safety.reserve ?? null,
      planAsOf: safety.planAsOf ?? null,
    });
  }
  exchangeSaleContext = { kind, safety, inspection: null };
  if (p.confirm === true) {
    const inspectionFile = path.join(AUTOPILOT, '.exchange-sale-inspections.json');
    const usedInspectionFile = path.join(AUTOPILOT, '.exchange-sale-inspections.used.json');
    const inspection = readInspectionArtifact(inspectionFile, kind);
    const inspected = validateFreshSaleInspection(
      inspection,
      latestCapturedState(),
      kind,
      p.qty,
      p.price,
    );
    if (!inspected.ok) {
      refuse(`exchange_sell inspection guard: ${inspected.reason}`, {
        kind,
        requestedQty: p.qty,
        requestedPrice: p.price,
        inspectedKind: inspected.inspectedKind ?? null,
        inspectedQty: inspected.inspectedQty ?? null,
        inspectedPrice: inspected.inspectedPrice ?? null,
      });
    }
    // A confirmed quote is single-use. Consume it atomically before any armed browser work;
    // an ambiguous failure therefore requires a fresh read-only inspection rather than a replay.
    try {
      consumeInspectionArtifact(
        inspectionFile,
        usedInspectionFile,
        kind,
        inspection.inspectionId,
      );
    } catch (error) {
      refuse('exchange_sell inspection guard: failed to atomically consume the inspection artifact', {
        kind,
        error: String(error.message || error).slice(0, 180),
      });
    }
    exchangeSaleContext.inspection = inspected;
  }
}
// ---- Full-senses guards (2026-07-25: chat/contracts/robots/auction). Validate BEFORE browser. ----
if (action === 'chat_post') {
  if (!CHAT_ROOMS.includes(p.room)) refuse('chat_post room must be one of: ' + CHAT_ROOMS.join(' | '), { got: p.room });
  p.text = String(p.text || '').trim();
  if (!p.text) refuse('chat_post needs non-empty text');
  if (p.text.length > 60 || /\r|\n/.test(p.text)) refuse('chat_post must be one line and <=60 chars', { len: p.text.length });
  if (/:re-\d+:/i.test(p.text)) refuse('chat_post cannot inject raw resource tokens; use chat_room_post structured parts');
  if (/^[@:]/.test(p.text)) refuse('chat_post text must not start with @ or : (opens a suggestion popup — probe §3)');
  const publicPolicy = evaluatePublicSend({
    text: p.text,
    roomId: p.room,
    reason: 'material-update',
    recentPublicMessages: recentPublicPosts(),
  });
  if (!publicPolicy.ok) refuse(`public chat policy: ${publicPolicy.reason}`, { policy: publicPolicy });
}
if (action === 'chat_private_send') {
  const policy = inspectOutgoingText(p.text, { scope: 'private' });
  if (!policy.ok) refuse(`private chat policy: ${policy.violations.join(', ')}`, { policy });
  if (p.confirm === true) {
    try {
      const sourceCreatedAt = new Date(p.sourceCreatedAt).toISOString();
      if (sourceCreatedAt !== p.sourceCreatedAt || !String(p.sourceMessageId || '').trim()) {
        throw new Error('private source identity is invalid');
      }
      chatPrivateOutbox = new PrivateSendOutbox(privateSendOutboxRoot());
      chatPrivateAttempt = {
        attemptId: p.attemptId,
        targetCompany: canonicalPrivateCompany(p.targetCompany),
        targetCompanyId: Number(p.targetCompanyId),
        messageText: canonicalPrivateMessageText(p.text),
        sourceText: canonicalSourceText(p.inReplyToText),
        sourceMessageId: String(p.sourceMessageId),
        sourceCreatedAt,
        runtimeMode: CHAT_MODE,
      };
      const existing = chatPrivateOutbox.getAttempt(p.attemptId);
      if (existing) {
        refuse('private send attemptId already exists in the durable NAS outbox; it cannot be replayed', {
          doNotRetry: true,
          replayBlocked: true,
          privateOutboxStatus: existing.status,
        });
      }
    } catch (_) {
      refuse('private send durable NAS outbox is unavailable; no browser send is authorized');
    }
  }
}
if (action === 'chat_private_retry_assess') {
  let durableAttempt;
  try {
    const outbox = new PrivateSendOutbox(privateSendOutboxRoot());
    durableAttempt = outbox.getAttempt(p.originalAttemptId);
  } catch (_) {
    refuse('private retry assessment requires a readable durable NAS outbox');
  }
  if (!durableAttempt) {
    refuse('private retry assessment requires an exact durable pre-click-failed attempt', {
      doNotRetry: true,
    });
  }
  if (durableAttempt.status !== 'pre-click-failed') {
    refuse('durable private attempt is not a proven pre-click failure; retry is blocked', {
      doNotRetry: true,
      replayBlocked: true,
      privateOutboxStatus: durableAttempt.status,
    });
  }
  let retryTarget;
  let retryText;
  try {
    retryTarget = canonicalPrivateCompany(p.targetCompany);
    retryText = canonicalPrivateMessageText(p.text);
  } catch (_) {
    refuse('private retry target or message is invalid', { doNotRetry: true });
  }
  if (durableAttempt.target.company !== retryTarget
      || durableAttempt.message.exactText !== retryText) {
    refuse('private retry target/message does not match the durable attempt', { doNotRetry: true });
  }
}
if (action === 'chat_room_post') {
  chatPublicParts = uiPublicParts(p.parts);
  chatPublicPlan = validatePublicPlan(p.room, p.parts, p.reason);
}
if (action === 'chat_room_reply') {
  let sourceCreatedAt = null;
  try { sourceCreatedAt = new Date(p.sourceCreatedAt).toISOString(); } catch (_) {}
  if (sourceCreatedAt !== p.sourceCreatedAt || !String(p.sourceMessageId || '').trim()
      || !Number.isSafeInteger(Number(p.sourceCompanyId)) || Number(p.sourceCompanyId) <= 0) {
    refuse('public reply requires exact source message, sender, and creation time evidence');
  }
  const prefix = replyPrefix(p.company);
  chatPublicParts = uiPublicParts(p.parts);
  chatPublicPlan = validatePublicPlan(p.room, p.parts, p.reason, prefix);
  chatPublicPlan.replyPrefix = prefix;
}
const chatRenderedText = action === 'chat_private_send'
  ? p.text
  : chatPublicPlan?.finalMarkup ?? null;
const economicCommunicationRequired = requireEconomicCommunicationAuthorization(chatRenderedText);
if (action === 'robots') {
  if (!p.buildingId) refuse('robots needs buildingId');
  if (p.confirm === true && !p.specialization)
    refuse('robots confirm requires specialization (the ONE resource the building gets locked to) — dry-read first to see options');
  if (p.buyMissing === true && (!Number.isFinite(Number(p.maxCost)) || Number(p.maxCost) <= 0))
    refuse('robots buyMissing requires an explicit positive maxCost from a fresh dry-read');
}
if (action === 'chat_contract_preview' && p.confirm !== false) {
  refuse('chat_contract_preview requires literal confirm:false and is always zero-click', {
    doNotClick: true,
    mutationAuthorized: false,
  });
}
if (action === 'contract_send') {
  p.qty = Number(p.qty ?? p.quantity); p.price = Number(p.price);
  if (!p.name || !p.company || !Number.isFinite(p.qty) || p.qty <= 0 || !Number.isFinite(p.price) || p.price <= 0)
    refuse('contract_send needs {name(imgname e.g. "water"), company, qty>0, price>0 per unit}', { got: p });
  if (p.confirm === true) {
    refuse('contract_send is preview-only until durable source-message terms, reserves, Transport, economics, and idempotency are verified at execution time');
  }
  try {   // price floor (mirror of exchange_sell): never contract goods away below half live exchange
    const nm = String(p.name).trim().toLowerCase().replace(/-/g, ' ');
    const names = JSON.parse(fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'names.json'), 'utf8'));
    const hit = Object.entries(names).find(([, n]) => n === nm);
    const ref = hit ? latestExchange(Number(hit[0])) : null;
    if (ref && p.price < 0.5 * ref && p.force !== true)
      refuse(`contract price $${p.price} < 50% of live exchange $${ref} for ${nm}`, { floor: +(0.5 * ref).toFixed(3) });
  } catch (e) {}
}
if (action === 'auction_info' && p.confirm === true)
  refuse('auction is read-only until irreversible auction execution has verified safety tooling');
if (action === 'chat_scan' && p.rooms != null &&
    (!Array.isArray(p.rooms) || !p.rooms.every(r => CHAT_ROOMS.includes(r))))
  refuse('chat_scan rooms must be an array among: ' + CHAT_ROOMS.join(' | ') + ' (or omit for all)', { got: p.rooms });

if (action === 'pa_consult_guide') {
  const pending = readPendingPa(PA_PENDING_FILE);
  if (!pending) {
    refuse('no valid persisted Personal Assistant offer exists; call pa_read first');
  }
  if (p.offerFingerprint !== pending.fingerprint) {
    refuse('offerFingerprint does not match the persisted Personal Assistant offer', {
      expectedFingerprint: pending.fingerprint,
    });
  }
  const preliminary = matchUniqueOption(pending.options, p.preliminaryChoice);
  if (!preliminary.ok) refuse(preliminary.reason, { options: pending.options });
  const existingReview = readPaReview(PA_REVIEW_FILE, pending);
  if (existingReview
      && (existingReview.preliminaryChoice !== preliminary.choice
        || existingReview.rationale !== normalizeText(p.rationale))) {
    refuse('the first independent PA assessment is immutable for this offer', {
      recordedPreliminaryChoice: existingReview.preliminaryChoice,
      recordedRationale: existingReview.rationale,
    });
  }
  let communityGuide = '';
  let measuredGuide = '';
  try {
    communityGuide = fs.readFileSync(path.join(REFERENCE, 'pa-quests-guide.md'), 'utf8');
    measuredGuide = fs.readFileSync(path.join(REFERENCE, 'pa-quests.md'), 'utf8');
  } catch (error) {
    refuse('Personal Assistant guide files are unavailable', {
      guideError: String(error.message || error).slice(0, 180),
    });
  }
  const consulted = consultPaGuides({
    offerText: pending.offerText,
    communityGuide,
    measuredGuide,
  });
  let review;
  try {
    review = buildPaReview({
      pending,
      preliminaryChoice: preliminary.choice,
      rationale: p.rationale,
      guideDigest: consulted.digest,
      matchCount: consulted.matchCount,
    });
    writePaReview(PA_REVIEW_FILE, review);
  } catch (error) {
    refuse(`could not persist the independent PA assessment: ${String(error.message || error)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    offerFingerprint: pending.fingerprint,
    independentAssessment: {
      preliminaryChoice: review.preliminaryChoice,
      rationale: review.rationale,
      recordedBeforeGuideDisclosure: true,
    },
    guide: {
      locallyMeasured: consulted.measured,
      communityReported: consulted.community,
      exactMatchFound: consulted.matchCount > 0,
      scoreMeaning: 'Cue-match score 1.0 is the strongest exact match, not weak evidence. Evidence reliability is labeled separately by source.',
      evidenceOrder: 'locally measured outcome > exact community match > fresh economics > unknown',
    },
    next: 'Compare the independent assessment with these matches. Complete guide outcomes describe reported consequences; use fresh economics to value them, never to assume an unreported alternative is free. For goods/cash choices, value all required owned goods at opportunity cost, inspect exact missing quantity, preserve the cash reserve, then call pa_reply.',
  }));
  process.exit(0);
}

if (p.confirm === true
    && ['chat_private_send', 'chat_room_reply', 'chat_room_post', 'contract_accept'].includes(action)) {
  consumeWorkerExecutionClaim();
}
if (p.confirm === true && ['chat_room_post', 'chat_room_reply'].includes(action)) {
  armPublicPostAttempt({
    room: p.room,
    text: chatPublicPlan.finalMarkup,
    attemptId: p.attemptId,
  });
}
if (economicCommunicationRequired) {
  // Consume before Chrome access. Any later ambiguity is terminal for this exact attempt.
  chatEconomicAuthorization = consumeEconomicCommunicationAuthorization();
}

(async () => {
  await cdp.connect();
  let res;
  const setId = `window.__companyId='${CFG.companyId}';`;
  const openContactSettings = async ({ targetCompany, targetCompanyId, attemptId }) => {
    await cdp.evaluate(`window.__chatContactSettings=${JSON.stringify({
      targetCompany,
      targetCompanyId,
      attemptId,
      confirm: true,
    })}; ${setId} return 1`);
    return cdp.evaluate(page('chat-contact-settings.js'));
  };
  const openContactPhase = async ({ targetCompany, targetCompanyId, attemptId, action: contactAction }) => {
    await cdp.evaluate(`window.__chatContactManage=${JSON.stringify({
      targetCompany,
      targetCompanyId,
      attemptId,
      action: contactAction,
      confirm: true,
    })}; ${setId} return 1`);
    return cdp.evaluate(page('chat-contact-manage.js'));
  };
  if (action === 'collect') {
    const landscapeUrl = 'https://www.simcompanies.com/landscape/';
    // The landscape fetches buildings but normally not the warehouse resource feed. The store
    // page is the established state-capture surface that supplies buildings, resources, and auth
    // together; return to the landscape only after that authoritative snapshot is complete.
    const collectStateUrl = B(CFG.storeId);
    const before = await captureCollectSnapshot(collectStateUrl);
    if (!before) refuse('could not capture authoritative buildings, resources, and cash before collect');
    await cdp.goto(landscapeUrl);
    await cdp.evaluate(`window.__collect=${JSON.stringify({ beforeBuildings: before.buildings })}; ${setId} return 1`);
    res = await cdp.evaluate(page('collect.js'));
    if (res?.verificationPending === true && Array.isArray(res.clicked) && res.clicked.length) {
      const after = await captureCollectSnapshot(collectStateUrl);
      const verification = verifyCollectionResult(
        before,
        after,
        res.clicked.map(item => item.buildingId),
      );
      res = {
        ...res,
        ok: verification.ok,
        collected: verification.ok,
        verified: verification.ok,
        verificationPending: false,
        doNotRetry: !verification.ok,
        verification,
        reason: verification.ok ? undefined
          : `collect clicks were not authoritatively verified: ${verification.reason}`,
      };
    }
  } else if (action === 'produce') {
    await cdp.goto(B(p.buildingId));
    const cash = await exactCashSnapshot();
    const targetHours = resolveTargetHours(p.targetHours, latestCapturedCompanyLevel());
    let batchPolicy = buildMillBatchPolicy(
      latestCapturedState(),
      p.buildingId,
      targetHours,
      Date.now(),
      p.name,
      p.finishBefore,
    );
    if (ownerBridgeAuthorization) {
      batchPolicy = {
        ...batchPolicy,
        ownerDirectiveId: ownerBridgeAuthorization.directiveId,
      };
    }
    await cdp.evaluate(`${buildProductionPolicyPagePrelude()} ${buildProductionCardBindingPagePrelude()} window.__evaluateMillBatchGuard=${evaluateMillBatchGuard.toString()}; window.__buildingHasBusyResource=${buildingHasBusyResource.toString()}; window.__parseExplicitCurrency=${parseExplicitCurrency.toString()}; window.__produce=${JSON.stringify({
      buildingId: p.buildingId,
      kind: productionResourceIdentity.kind,
      resourceSlug: productionResourceIdentity.resourceSlug,
      kindSource: productionResourceIdentity.kindSource,
      name: p.name,
      qty: p.qty,
      targetHours,
      finishBefore: p.finishBefore,
      checkpointBufferSeconds: productionCheckpoint?.bufferSeconds ?? 60,
      minCashAfter: p.minCashAfter ?? (CFG.minCash || 800),
      maxBuyCost: 0,
      cash,
      batchPolicy,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('produce.js'));
  } else if (action === 'inspect_exchange_buy') {
    await cdp.goto(`https://www.simcompanies.com/market/resource/${p.kind}/`);
    await cdp.evaluate(`window.__planExactMarketPurchase=${planExactMarketPurchase.toString()}; window.__inspectExchangeBuy=${JSON.stringify({
      kind: p.kind,
      quantity: p.quantity,
      maxUnitPrice: p.maxUnitPrice,
      minCashAfter: Math.max(500, Number(CFG.minCash ?? 800)),
      companyId: String(CFG.companyId),
    })}; ${setId} return 1`);
    res = await cdp.evaluate(`
      const request = window.__inspectExchangeBuy;
      const market = await api('/api/v3/market/0/' + request.kind + '/');
      const auth = await api('/api/v3/companies/auth-data/');
      const resources = await api('/api/v3/resources/' + request.companyId + '/');
      const cashRaw = auth.json?.money ?? auth.json?.authCompany?.money;
      const cash = cashRaw == null || cashRaw === '' ? null : Number(cashRaw);
      const stock = Array.isArray(resources.json)
        ? resources.json
          .filter(row => Number(row?.kind) === Number(request.kind))
          .reduce((total, row) => total + Number(row?.amount || 0), 0)
        : null;
      if (market.status !== 200 || !Array.isArray(market.json)) {
        return { ok: false, readOnly: true, submitted: false,
          reason: 'authoritative Exchange book is unavailable', marketStatus: market.status };
      }
      if (auth.status !== 200 || !Number.isFinite(cash)) {
        return { ok: false, readOnly: true, submitted: false,
          reason: 'authoritative cash is unavailable', authStatus: auth.status };
      }
      if (resources.status !== 200 || !Number.isFinite(stock)) {
        return { ok: false, readOnly: true, submitted: false,
          reason: 'authoritative inventory is unavailable', resourcesStatus: resources.status };
      }
      const spendable = Math.max(0, cash - request.minCashAfter);
      const quote = window.__planExactMarketPurchase(
        market.json,
        request.quantity,
        Math.max(spendable, 0.000001),
        request.maxUnitPrice,
      );
      return {
        ok: quote.ok === true,
        readOnly: true,
        submitted: false,
        source: '/api/v3/market/0/' + request.kind + '/',
        observedAt: new Date().toISOString(),
        kind: request.kind,
        requestedQuantity: request.quantity,
        currentStock: stock,
        cash,
        minCashAfter: request.minCashAfter,
        spendableCash: spendable,
        cashAfter: quote.ok ? Math.round((cash - quote.estimatedCost) * 1e6) / 1e6 : null,
        buyerCosts: {
          exchangeFee: 0,
          transportUnits: 0,
          note: 'The buyer-side Exchange flow charges neither market fee nor warehouse Transport.',
        },
        quote,
        reason: quote.ok ? undefined : quote.reason,
      };
    `);
  } else if (action === 'buy') {
    await cdp.goto(`https://www.simcompanies.com/market/resource/${p.kind}/`);
    await cdp.evaluate(`window.__planMarketPurchase=${planMarketPurchase.toString()}; window.__planExactMarketPurchase=${planExactMarketPurchase.toString()}; window.__quoteFixedMarketPurchase=${quoteFixedMarketPurchase.toString()}; window.__buy=${JSON.stringify({
      kind: p.kind,
      quantity: p.quantity,
      maxSpend: p.maxSpend,
      ask: p.ask,
      minCashAfter: Math.max(500, Number(p.minCashAfter ?? CFG.minCash ?? 800)),
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('buy.js'));
  } else if (action === 'build') {
    const landscapeUrl = 'https://www.simcompanies.com/landscape/';
    const beforeBuildings = p.confirm === true
      ? await captureBuildings(landscapeUrl)
      : (await cdp.goto(landscapeUrl), null);
    if (p.confirm === true && !beforeBuildings) refuse('could not capture authoritative buildings before construction');
    const cash = await exactCashSnapshot();
    await cdp.evaluate(`window.__evaluateSpendGuard=${evaluateSpendGuard.toString()}; window.__build=${JSON.stringify({ building: p.building, maxCost: p.maxCost, minCashAfter: p.minCashAfter ?? 4000, effectiveCost: p.effectiveCost, confirm: p.confirm === true, cash, beforeBuildings })}; ${setId} return 1`);
    res = await cdp.evaluate(page('build.js'));
    if (p.confirm === true && res?.commitClicked === true) {
      const afterBuildings = await captureBuildings(landscapeUrl);
      const verified = verifyNewBuildingStarted(beforeBuildings, afterBuildings, p.building);
      res = { ...res, ok: verified.ok, verified: verified.ok, doNotRetry: !verified.ok,
        newBuildingId: verified.buildingId || null,
        constructionCompletesAt: verified.completesAt || null,
        reason: verified.ok ? undefined : `BUILD was clicked but construction was not authoritatively verified: ${verified.reason}` };
      if (verified.ok) {
        const registration = recordOwnerProspectorBuildTarget(
          path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
          {
            verified: true,
            building: p.building,
            buildingId: verified.buildingId,
            completesAt: verified.completesAt || null,
          },
        );
        if (registration.applicable) {
          res = {
            ...res,
            ownerAchievementTargetRegistered: registration.ok === true,
            ownerAchievementRegistration: registration,
            ...(!registration.ok ? { doNotRetry: true } : {}),
          };
        }
      }
    }
  } else if (action === 'upgrade') {
    const beforeBuildings = p.confirm === true
      ? await captureBuildings(B(p.buildingId))
      : (await cdp.goto(B(p.buildingId)), null);
    if (p.confirm === true && !beforeBuildings) refuse('could not capture authoritative buildings before upgrade');
    const cash = await exactCashSnapshot();
    await cdp.evaluate(`window.__upgrade=${JSON.stringify({ buildingId: p.buildingId, maxCost: p.maxCost, minCashAfter: p.minCashAfter ?? 4000, confirm: p.confirm === true, cash, beforeBuildings })}; ${setId} return 1`);
    res = await cdp.evaluate(page('upgrade.js'));
    if (p.confirm === true && res?.commitClicked === true) {
      const afterBuildings = await captureBuildings(B(p.buildingId));
      const verified = verifyBuildingUpgradeStarted(beforeBuildings, afterBuildings, p.buildingId);
      res = { ...res, ok: verified.ok, verified: verified.ok, doNotRetry: !verified.ok,
        fromLevel: verified.fromLevel ?? null, toLevel: verified.toLevel ?? null,
        reason: verified.ok ? undefined : `UPGRADE NOW was clicked but construction was not authoritatively verified: ${verified.reason}` };
    }
  } else if (action === 'scrap') {
    // Chairman-authorized demolition (2026-07-25: Slaughterhouse -> free the slot for the
    // self-produced-coffee plan). scrap.js is self-gating: without confirm:true it dry-reads,
    // and it REFUSES an ambiguous confirm button rather than click blind. Returns 100% of the
    // building's cumulative materials to the warehouse (company Lv>=5, verified).
    const beforeBuildings = p.confirm === true
      ? await captureBuildings(B(p.buildingId))
      : (await cdp.goto(B(p.buildingId)), null);
    if (p.confirm === true && !beforeBuildings) refuse('could not capture authoritative buildings before scrap');
    await cdp.evaluate(`window.__scrap=${JSON.stringify({
      buildingId: p.buildingId,
      confirm: p.confirm === true,
      beforeBuildings,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('scrap.js'));
    if (p.confirm === true && res?.commitClicked === true) {
      const afterBuildings = await captureBuildings('https://www.simcompanies.com/landscape/');
      const verified = verifyBuildingRemoved(beforeBuildings, afterBuildings, p.buildingId);
      res = { ...res, ok: verified.ok, verified: verified.ok, doNotRetry: !verified.ok,
        reason: verified.ok ? undefined : `SCRAP was clicked but removal was not authoritatively verified: ${verified.reason}` };
    }
  } else if (action === 'rebuild') {
    const beforeBuildings = await captureBuildings(B(p.buildingId));
    const buildingsCapturedAt = new Date().toISOString();
    if (!beforeBuildings) refuse('could not capture authoritative buildings before rebuild');
    const beforeMatches = beforeBuildings.filter(building => Number(building?.id) === Number(p.buildingId));
    if (beforeMatches.length !== 1) refuse('exact rebuild target is missing or duplicated');
    const beforeBuilding = beforeMatches[0];
    const name = String(beforeBuilding?.name || '').trim().toLowerCase();
    if (!['quarry', 'mine', 'oil rig'].includes(name) || Number(beforeBuilding?.size) !== 1) {
      refuse('rebuild is limited to an exact level-1 Quarry, Mine, or Oil rig');
    }
    const idle = await captureRebuildIdleEvidence(beforeBuilding, p.buildingId);
    if (!idle.ok) refuse(idle.reason || 'exact rebuild target is not proven idle');
    let ownerAttempt = null;
    if (p.confirm === true) {
      const ownerProgressObservation = await captureOwnerProspectorOverview();
      ownerAttempt = refreshAndClaimOwnerProspectorRebuildAttempt(
        path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
        p.buildingId,
        ownerProgressObservation,
        Date.now(),
        {
          source: 'authoritative-buildings-capture',
          capturedAt: buildingsCapturedAt,
          buildings: beforeBuildings,
          idleEvidence: idle.evidence,
        },
      );
      if (!ownerAttempt.ok) refuse(ownerAttempt.reason, {
        ownerDirectiveEvidence: ownerAttempt.ownerDirectiveEvidence || null,
      });
    }
    await cdp.evaluate(`window.__rebuild=${JSON.stringify({
      buildingId: p.buildingId,
      confirm: p.confirm === true,
      beforeBuilding,
      idleEvidence: idle.evidence,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('rebuild.js'));
    if (p.confirm === true && res?.commitClicked === true) {
      const afterBuildings = await captureBuildings('https://www.simcompanies.com/landscape/');
      const verified = verifyBuildingRebuildStarted(
        beforeBuildings, afterBuildings, p.buildingId, idle.evidence);
      res = { ...res, ok: verified.ok, verified: verified.ok, doNotRetry: !verified.ok,
        rebuiltBuildingId: verified.buildingId || null,
        replacedBuildingId: verified.replacedBuildingId || Number(p.buildingId),
        rebuildCompletesAt: verified.completesAt || null,
        reason: verified.ok ? undefined
          : `REBUILD was clicked but reconstruction was not authoritatively verified: ${verified.reason}` };
    }
    if (p.confirm === true && ownerAttempt?.attemptId) {
      recordOwnerProspectorRebuildOutcome(
        path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
        ownerAttempt.attemptId,
        res,
      );
      res = { ...res, ownerAttemptId: ownerAttempt.attemptId };
    }
  } else if (action === 'exchange_sell') {
    // Sell warehouse stock on the EXCHANGE via the proven UI driver (direct API is bot-blocked).
    // {name(imgname like "water"/"coffee-ground"), qty, price, confirm}. Dry (no confirm) fills the
    // dialog and returns the game's own numbers WITHOUT submitting — read them before confirming.
    const nm = p.name;
    try {   // price floor: never list below 50% of the live exchange price unless forced
      const names = JSON.parse(fs.readFileSync(path.join(SHARED, 'price-tracker', 'data', 'names.json'), 'utf8'));
      const hit = Object.entries(names).find(([, n]) => n === nm.replace(/-/g, ' '));
      const ref = hit ? latestExchange(Number(hit[0])) : null;
      if (ref && p.price < 0.5 * ref && !p.force)
        refuse(`price $${p.price} < 50% of live exchange $${ref} for ${nm}`, { floor: +(0.5 * ref).toFixed(3) });
    } catch (e) {}
    const verified = exchangeSaleContext?.inspection;
    const args = [
      path.join(ACTIONS, 'sell-exchange-ui.js'),
      nm,
      String(p.qty),
      String(p.price),
      JSON.stringify({
        kind: exchangeSaleContext?.kind,
        reserve: verified?.reserve ?? exchangeSaleContext?.safety?.reserve,
        reserveValidUntil: verified?.expiresAt ?? null,
        transportPerUnit: verified?.transportPerUnit ?? exchangeSaleContext?.safety?.transportPerUnit,
        lotIndex: verified?.selectedLotIndex ?? null,
        lotQuality: verified?.selectedLotQuality ?? null,
        lotUnitCost: verified?.selectedLotUnitCost ?? null,
      }),
    ];
    if (p.confirm === true) args.push('--submit');
    let out = '';
    let uiResult = null;
    try {
      out = require('child_process').execFileSync(process.execPath, args, {
        cwd: DIR,
        timeout: 120000,
        encoding: 'utf8',
      });
      uiResult = JSON.parse(out.trim());
    } catch (error) {
      // Expected UI refusals (notably a too-small quality lot) are actionable results. Preserve
      // their complete structured stdout so the brain can retry a quantity from qualityChoices.
      const stdout = String(error?.stdout || out || '').trim();
      try { uiResult = JSON.parse(stdout); }
      catch (_) {
        uiResult = {
          ok: false,
          reason: 'exchange UI returned non-JSON output',
          error: String(error.message || error).slice(0, 300),
        };
      }
    }
    if (!Array.isArray(uiResult.qualityChoices) && Array.isArray(uiResult.qualitySelection?.choices)) {
      uiResult.qualityChoices = uiResult.qualitySelection.choices;
    }
    // The UI driver pretty-prints JSON. Parse and re-emit it rather than clipping the tail, which
    // can turn a successful result into invalid JSON and hide verification fields.
    console.log(JSON.stringify(uiResult));
    process.exit(0);
  } else if (action === 'pa_read') {
    // Opening the conversation clears the unread badge. Persist the exact unresolved offer so a
    // later refresh still knows that a decision is pending. Deliberately do not disclose guide
    // text here: the model must first record its own assessment through pa_consult_guide.
    await cdp.goto('https://www.simcompanies.com/messages/');
    const paMsg = await cdp.evaluate(page('pa-read.js'));
    const pending = buildPendingPa(paMsg);
    if (pending) {
      const previousPending = readPendingPa(PA_PENDING_FILE);
      const retainReview = previousPending?.fingerprint === pending.fingerprint
        && readPaReview(PA_REVIEW_FILE, previousPending);
      writePendingPa(PA_PENDING_FILE, pending);
      if (!retainReview) clearPaReview(PA_REVIEW_FILE);
      writePaStatus(PA_STATUS_FILE, {
        status: 'ok',
        unread: 0,
        rowText: paMsg.paRow,
        source: 'rendered-personal-assistant-ui',
      });
      res = {
        ok: true,
        pending: true,
        offerFingerprint: pending.fingerprint,
        observedAt: pending.observedAt,
        offerText: pending.offerText,
        options: pending.options,
        guideDisclosed: false,
        next: 'Independently select one displayed option and state a concise business rationale. Then call pa_consult_guide with this fingerprint; it records that assessment before returning any guide match.',
      };
    } else if (paMsg?.ok === true) {
      clearPendingPa(PA_PENDING_FILE);
      clearPaReview(PA_REVIEW_FILE);
      writePaStatus(PA_STATUS_FILE, {
        status: 'ok',
        unread: 0,
        rowText: paMsg.paRow,
        source: 'rendered-personal-assistant-ui',
      });
      res = {
        ok: true,
        pending: false,
        reason: 'Personal Assistant conversation has no open reply choices',
      };
    } else {
      res = {
        ok: false,
        reason: paMsg?.reason || 'Personal Assistant read failed',
      };
    }
  } else if (action === 'pa_reply') {
    // The exact offer must have survived pa_read -> independent assessment -> guide consultation.
    // Re-read the live rendered choices and bind their fingerprint immediately before one click.
    const pending = readPendingPa(PA_PENDING_FILE);
    if (!pending) refuse('pa_reply requires a valid pending offer; call pa_read first');
    if (p.offerFingerprint !== pending.fingerprint) {
      refuse('pa_reply offerFingerprint does not match the pending offer', {
        expectedFingerprint: pending.fingerprint,
      });
    }
    const review = readPaReview(PA_REVIEW_FILE, pending);
    if (!review) {
      refuse('pa_reply requires a current independent assessment followed by pa_consult_guide');
    }
    let communityGuide = '';
    let measuredGuide = '';
    try {
      communityGuide = fs.readFileSync(path.join(REFERENCE, 'pa-quests-guide.md'), 'utf8');
      measuredGuide = fs.readFileSync(path.join(REFERENCE, 'pa-quests.md'), 'utf8');
    } catch (error) {
      refuse('Personal Assistant guide files are unavailable before reply');
    }
    const currentGuide = consultPaGuides({
      offerText: pending.offerText,
      communityGuide,
      measuredGuide,
    });
    if (currentGuide.digest !== review.guideDigest) {
      clearPaReview(PA_REVIEW_FILE);
      refuse('Personal Assistant guide changed after consultation; reassess with pa_consult_guide');
    }
    const finalChoice = matchUniqueOption(pending.options, p.choice);
    if (!finalChoice.ok) refuse(finalChoice.reason, { options: pending.options });
    await cdp.goto('https://www.simcompanies.com/messages/');
    const liveMessage = await cdp.evaluate(page('pa-read.js'));
    const livePending = buildPendingPa(liveMessage);
    if (!livePending || livePending.fingerprint !== pending.fingerprint) {
      res = {
        ok: false,
        guard: true,
        mutationAttempted: false,
        reason: 'the live Personal Assistant offer no longer matches the reviewed fingerprint; no reply was clicked',
        expectedFingerprint: pending.fingerprint,
        liveFingerprint: livePending?.fingerprint || null,
      };
    } else {
      // Consume the review before dispatch. An ambiguous click cannot reuse the same authorization.
      clearPaReview(PA_REVIEW_FILE);
      await cdp.evaluate(`window.__paChoice=${JSON.stringify(finalChoice.choice)}; ${setId} return 1`);
      res = await cdp.evaluate(page('pa-reply.js'));
      const history = {
        schemaVersion: 1,
        attemptedAt: new Date().toISOString(),
        offerFingerprint: pending.fingerprint,
        offerText: pending.offerText,
        options: pending.options,
        preliminaryChoice: review.preliminaryChoice,
        preliminaryRationale: review.rationale,
        guideMatchCount: review.matchCount,
        finalChoice: finalChoice.choice,
        comparison: String(p.comparison).replace(/\s+/gu, ' ').trim(),
        verified: res?.ok === true,
        outcome: res?.outcome || null,
        economics: res?.economics || null,
        resultTail: String(res?.resultTail || '').slice(-2200),
      };
      fs.appendFileSync(PA_HISTORY_FILE, `${JSON.stringify(history)}\n`, { mode: 0o600 });
      if (res?.ok === true) {
        clearPendingPa(PA_PENDING_FILE);
        writePaStatus(PA_STATUS_FILE, {
          status: 'ok',
          unread: 0,
          rowText: liveMessage.paRow,
          source: 'rendered-personal-assistant-ui',
        });
      }
      res = {
        ...res,
        offerFingerprint: pending.fingerprint,
        independentAssessment: {
          preliminaryChoice: review.preliminaryChoice,
          rationale: review.rationale,
        },
        finalChoice: finalChoice.choice,
        comparison: history.comparison,
      };
    }
  } else if (action === 'bonds') {
    // Issue / adjust / repay bonds on the HQ finance page. {amount, interest, confirm}.
    // Listing is NOT instant cash — players buy over time (verified operating constraint, 2026-07-25).
    await cdp.goto('https://www.simcompanies.com/headquarters/finance/');
    await cdp.evaluate(`window.__bonds=${JSON.stringify({ amount: p.amount, interest: p.interest, confirm: p.confirm === true })}; ${setId} return 1`);
    res = await cdp.evaluate(page('bonds-adjust.js'));
    if (p.confirm === true && res?.clicked === true) {
      // A React input can retain the requested text even when UPDATE was rejected. Re-open the
      // finance route and independently dry-read the server-backed form before reporting success.
      await cdp.goto('https://www.simcompanies.com/headquarters/finance/');
      await cdp.evaluate(`window.__bonds=${JSON.stringify({ amount: p.amount, interest: p.interest, confirm: false })}; ${setId} return 1`);
      const persisted = await cdp.evaluate(page('bonds-adjust.js'));
      const verified = persisted?.ok === true
        && bondOfferMatches(persisted.current, p.amount, p.interest);
      res = {
        ...res,
        ok: verified,
        verified,
        mutationAttempted: true,
        doNotRetry: !verified,
        outcome: verified ? 'PERSISTED_UNSOLD_OFFER' : 'UNKNOWN_NOOP_OR_IMMEDIATE_SALE',
        persistedOffer: persisted?.current || null,
        reason: verified ? undefined
          : 'UPDATE was clicked, but a fresh finance-page read did not match the requested unsold offer; do not treat it as funding',
      };
    }
  } else if (action === 'sell') {
    await cdp.goto(B(p.buildingId || CFG.storeId));
    const quotes = [];
    const seen = new Set();
    const probePrice = async (candidate) => {
      const key = Number(candidate).toFixed(2);
      if (seen.has(key)) return;
      seen.add(key);
      await cdp.evaluate(`window.__probe=${JSON.stringify({
        name: p.name,
        qty: p.qty,
        price: Number(candidate),
      })}; ${setId} return 1`);
      const probe = await cdp.evaluate(page('probe-retail.js'));
      if (!probe || !probe.ok) {
        const reason = probe?.reason || 'probe failed';
        quotes.push({ price: Number(candidate), valid: false, reason });
        if (/store still busy/i.test(reason)) {
          refuse('Grocery is already busy; no price was tested and no sale was started');
        }
        return;
      }
      const enteredPrice = Number(probe.entered?.price);
      const enteredQty = Number(probe.entered?.qty);
      const sellEnabled = Array.isArray(probe.buttons)
        && probe.buttons.some((button) => /^SELL$/i.test(String(button.t || '').trim())
          && !button.disabled && !button.ariaDisabled
          && !button.classDisabled && !button.pointerDisabled);
      const quote = parseRetailQuote(probe.text,
        Number.isFinite(enteredPrice) && enteredPrice > 0 ? enteredPrice : candidate);
      quote.enteredQty = Number.isFinite(enteredQty) ? enteredQty : null;
      quote.sellEnabled = sellEnabled;
      quote.valid = quote.valid
        && Number.isFinite(enteredQty)
        && Math.abs(enteredQty - p.qty) < 1e-9
        && sellEnabled;
      quotes.push(quote);
    };

    for (const candidate of coarsePriceCandidates(p.price, retailMinPrice)) {
      await probePrice(candidate);
    }
    const coarseBest = chooseBestRetailQuote(quotes);
    if (!coarseBest) refuse('retail price scan found no positive valid quote; sale was not started',
      { anchorPrice: p.price, tested: quotes });
    for (const candidate of finePriceCandidates(p.price, coarseBest.price, retailMinPrice)) {
      await probePrice(candidate);
    }
    const best = chooseBestRetailQuote(quotes);
    if (!best) refuse('retail fine scan found no positive valid quote; sale was not started',
      { anchorPrice: p.price, tested: quotes });

    await cdp.evaluate(`window.__buildingHasBusyResource=${buildingHasBusyResource.toString()}; window.__sell=${JSON.stringify({
      buildingId: p.buildingId || CFG.storeId,
      kind: KIND_OF[p.name] ?? null,
      name: p.name,
      qty: p.qty,
      price: best.price,
    })}; ${setId} return 1`);
    const sale = await cdp.evaluate(page('sell.js'));
    res = {
      ...sale,
      retailOptimization: {
        anchorPrice: p.price,
        minimumPrice: +retailMinPrice.toFixed(2),
        tested: quotes.sort((a, b) => a.price - b.price),
        chosen: best,
      },
    };
  } else if (action === 'chat_scan') {
    // Read chat rooms via their REAL URLs (board/.probe-chat.md §2 — sidebar clicking races the
    // pane render and mis-attributes rooms). All rooms read inside THIS one cdp session (B5).
    const want = Array.isArray(p.rooms) && p.rooms.length
      ? p.rooms.filter(r => CHAT_ROOMS.includes(r)) : CHAT_ROOMS;
    if (!want.length) refuse('chat_scan rooms must be among: ' + CHAT_ROOMS.join(' | '), { got: p.rooms });
    res = { ok: true, rooms: {}, failedRooms: [] };
    for (const room of want) {
      await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(room) + '/');
      await cdp.evaluate(`window.__chatroom=${JSON.stringify(room)}; return 1`);
      const r = await cdp.evaluate(page('chat-read.js'));
      res.rooms[room] = r && r.ok ? { unread: r.unread, messages: r.messages } : r;
      res[room] = res.rooms[room];
      if (!r?.ok) res.failedRooms.push(room);
    }
    res.ok = res.failedRooms.length === 0;
    if (!res.ok) res.reason = `chat scan failed for: ${res.failedRooms.join(', ')}`;
  } else if (action === 'chat_post') {
    // Post ONE message (validated + rate-limited above). chat-post.js is self-gating: dry
    // without confirm:true; refuses ambiguous composer/send-button. Conduct rules in BRAIN.md.
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatpost=${JSON.stringify({ room: p.room, text: p.text, confirm: p.confirm === true })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-post.js'));
    // Rate-limit log: `posted` key exists ONLY after the send button was actually clicked
    // (posted:false = clicked but tail-verify failed — the post may still have landed, so log
    // it anyway; fail-safe for the owner's no-spam rule). Pre-click refusals have no `posted`.
    res = auditPublicPostOutcome(res,
      { t: Date.now(), room: p.room, text: p.text, verified: res?.posted === true });
  } else if (action === 'chat_rooms_discover') {
    await cdp.goto('https://www.simcompanies.com/messages/');
    res = await cdp.evaluate(page('chat-room-discover.js'));
  } else if (action === 'chat_room_read') {
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatRoomRead=${JSON.stringify({ room: p.room })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-room-read.js'));
  } else if (action === 'chat_room_scroll') {
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatRoomScroll=${JSON.stringify({ room: p.room, direction: p.direction })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-room-scroll.js'));
  } else if (action === 'chat_room_post') {
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatRoomPost=${JSON.stringify({
      room: p.room,
      parts: chatPublicParts,
      replyPrefix: '',
      attemptId: p.attemptId,
      maxChars: 60,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-room-post.js'));
    res = auditPublicPostOutcome(res,
      {
        t: Date.now(),
        room: p.room,
        text: chatPublicPlan.finalMarkup,
        verified: res?.posted === true,
        attemptId: p.attemptId,
        status: res?.posted === true ? 'VERIFIED' : 'UNKNOWN',
      });
  } else if (action === 'chat_room_reply') {
    const prefix = chatPublicPlan.replyPrefix;
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatRoomRead=${JSON.stringify({ room: p.room })}; ${setId} return 1`);
    const sourceEvidence = await cdp.evaluate(page('chat-room-read.js'));
    const sourceMatches = [];
    for (const group of Array.isArray(sourceEvidence?.groups) ? sourceEvidence.groups : []) {
      if (group?.fromMe === true
          || group?.company !== p.company
          || Number(group?.companyId) !== Number(p.sourceCompanyId)
          || group?.authorStatus !== 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER'
          || group?.directionStatus !== 'VERIFIED_RENDERED_COMPONENT_AND_STYLE') continue;
      for (const message of Array.isArray(group?.messages) ? group.messages : []) {
        const createdAt = message?.exactTime ?? group?.exactTime;
        const timeStatus = message?.timeStatus ?? group?.timeStatus;
        if (String(message?.messageId) === String(p.sourceMessageId)
            && message?.idStatus === 'VERIFIED_RENDERED_COMPONENT_ID'
            && createdAt === p.sourceCreatedAt
            && timeStatus === 'VERIFIED_RENDERED_COMPONENT_DATETIME'
            && String(message?.text ?? message?.visibleText ?? '').normalize('NFKC').trim()
              === String(p.bodyContains).normalize('NFKC').trim()) {
          sourceMatches.push({ group, message });
        }
      }
    }
    if (sourceEvidence?.ok !== true || sourceMatches.length !== 1) {
      refuse('public reply source ID, time, sender, and body were not uniquely re-verified', {
        sourceMatchCount: sourceMatches.length,
      });
    }
    const replyRequest = {
      room: p.room,
      company: p.company,
      bodyContains: p.bodyContains || '',
      conversationHref: p.conversationHref,
      requireExactBody: true,
      sourcePreverified: true,
      sourceMessageId: String(p.sourceMessageId),
      sourceCreatedAt: p.sourceCreatedAt,
      sourceCompanyId: Number(p.sourceCompanyId),
      confirm: p.confirm === true,
    };
    await cdp.evaluate(`window.__chatRoomReply=${JSON.stringify(replyRequest)}; ${setId} return 1`);
    const replyResult = await cdp.evaluate(page('chat-room-reply.js'));
    if (p.confirm !== true || replyResult?.ok !== true) {
      res = { ...replyResult, compositeReply: true, wouldPost: chatPublicPlan.finalMarkup };
    } else {
      await cdp.evaluate(`window.__chatRoomPost=${JSON.stringify({
        room: p.room,
        parts: chatPublicParts,
        replyPrefix: prefix,
        attemptId: p.attemptId,
        maxChars: 60,
        confirm: true,
      })}; ${setId} return 1`);
      const postResult = await cdp.evaluate(page('chat-room-post.js'));
      res = {
        ...postResult,
        compositeReply: true,
        replyTargetVerified: true,
        replySourceMessageIdVerified: replyResult.sourceMessageIdVerified ?? null,
        replySourceCompanyIdVerified: replyResult.sourceCompanyIdVerified ?? null,
        replySourceCreatedAtVerified: replyResult.sourceCreatedAtVerified ?? null,
      };
      res = auditPublicPostOutcome(res,
        {
          t: Date.now(),
          room: p.room,
          text: chatPublicPlan.finalMarkup,
          verified: postResult?.posted === true,
          attemptId: p.attemptId,
          status: postResult?.posted === true ? 'VERIFIED' : 'UNKNOWN',
        });
    }
  } else if (action === 'chat_private_open') {
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    await cdp.evaluate(`window.__chatPrivateOpen=${JSON.stringify({
      room: p.room,
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      sourceText: p.sourceText,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-private-open-from-public.js'));
  } else if (action === 'chat_private_start') {
    await cdp.goto('https://www.simcompanies.com/search/');
    await cdp.evaluate(`window.__chatPrivateStart=${JSON.stringify({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      targetRealmId: p.targetRealmId,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-private-start.js'));
  } else if (action === 'chat_private_read') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    await cdp.evaluate(`window.__chatPrivateRead=${JSON.stringify({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      previousSnapshotFingerprint: p.previousSnapshotFingerprint,
      cursorTail: p.cursorTail,
      loadFull: p.loadFull,
      maxScrolls: p.maxScrolls,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-private-read.js'));
  } else if (action === 'chat_private_send') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    let privateSource = null;
    if (p.confirm === true && chatPrivateAttempt.sourceText != null) {
      await cdp.evaluate(`window.__chatPrivateRead=${JSON.stringify({
        targetCompany: chatPrivateAttempt.targetCompany,
        targetCompanyId: chatPrivateAttempt.targetCompanyId,
        previousSnapshotFingerprint: null,
        cursorTail: null,
        loadFull: false,
        maxScrolls: 1,
      })}; ${setId} return 1`);
      const evidence = await cdp.evaluate(page('chat-private-read.js'));
      if (evidence?.idVerified !== true) {
        refuse('private reply target company name and ID are not uniquely bound in contacts', {
          targetCompany: chatPrivateAttempt.targetCompany,
          targetCompanyId: chatPrivateAttempt.targetCompanyId,
        });
      }
      const wanted = chatPrivateAttempt.sourceText;
      const matches = (evidence?.thread?.messages || []).filter(message => {
        if (message?.direction !== 'INCOMING') return false;
        if (message?.idStatus !== 'VERIFIED_RENDERED_COMPONENT_ID'
            || message?.timeStatus !== 'VERIFIED_RENDERED_COMPONENT_DATETIME'
            || message?.authorStatus !== 'VERIFIED_RENDERED_COMPONENT_AND_VISIBLE_HEADER'
            || message?.directionStatus !== 'VERIFIED_RENDERED_COMPONENT_AND_STYLE'
            || String(message?.serverMessageId) !== chatPrivateAttempt.sourceMessageId
            || message?.exactCreatedAt !== chatPrivateAttempt.sourceCreatedAt
            || message?.authorCompany !== chatPrivateAttempt.targetCompany
            || Number(message?.authorCompanyId) !== chatPrivateAttempt.targetCompanyId) return false;
        try { return canonicalSourceText(String(message?.visibleBody || '')) === wanted; }
        catch (_) { return false; }
      });
      if (matches.length !== 1) {
        refuse('private reply source message is not uniquely verified in the exact rendered pane', {
          sourceMatchCount: matches.length,
          targetCompany: chatPrivateAttempt.targetCompany,
        });
      }
      privateSource = {
        kind: 'reply',
        exactText: wanted,
        messageId: chatPrivateAttempt.sourceMessageId,
        createdAt: chatPrivateAttempt.sourceCreatedAt,
        authorCompany: chatPrivateAttempt.targetCompany,
        authorCompanyId: chatPrivateAttempt.targetCompanyId,
        evidenceStatus: 'EXACT_RENDERED_INBOUND',
        matchCount: 1,
        observationFingerprint: matches[0]?.observationFingerprint || null,
      };
    }
    if (p.confirm !== true) {
      await cdp.evaluate(`window.__chatPrivateSend=${JSON.stringify({
        targetCompany: p.targetCompany,
        targetCompanyId: p.targetCompanyId,
        text: p.text,
        attemptId: p.attemptId,
        confirm: false,
      })}; ${setId} return 1`);
      res = await cdp.evaluate(page('chat-private-send.js'));
    } else {
      if (!privateSource) {
        privateSource = {
          kind: 'proactive',
          exactText: null,
          messageId: null,
          createdAt: null,
          authorCompany: null,
          authorCompanyId: null,
          evidenceStatus: 'NOT_APPLICABLE_PROACTIVE',
          matchCount: 0,
          observationFingerprint: null,
        };
      }
      const durableAttempt = { ...chatPrivateAttempt, source: privateSource };
      const setPrivateSendRequest = async confirm => {
        await cdp.evaluate(`window.__chatPrivateSend=${JSON.stringify({
          targetCompany: durableAttempt.targetCompany,
          targetCompanyId: durableAttempt.targetCompanyId,
          text: durableAttempt.messageText,
          attemptId: durableAttempt.attemptId,
          confirm,
        })}; ${setId} return 1`);
        return cdp.evaluate(page('chat-private-send.js'));
      };
      res = await runDurablePrivateSendAttempt({
        outbox: chatPrivateOutbox,
        attempt: durableAttempt,
        preflight: () => setPrivateSendRequest(false),
        send: () => setPrivateSendRequest(true),
      });
      res = {
        ...res,
        sourceMessageIdVerified: privateSource.messageId,
        sourceCreatedAtVerified: privateSource.createdAt,
      };
    }
  } else if (action === 'chat_private_retry_assess') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    await cdp.evaluate(`window.__chatPrivateRetry=${JSON.stringify({
      targetCompany: p.targetCompany,
      text: p.text,
      originalAttemptId: p.originalAttemptId,
      originalOutcome: p.originalOutcome,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-private-retry.js'));
  } else if (action === 'chat_contact_list') {
    await cdp.goto('https://www.simcompanies.com/messages/');
    res = await cdp.evaluate(page('chat-contact-list.js'));
  } else if (action === 'chat_contact_read') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    await cdp.evaluate(`window.__chatContactRead=${JSON.stringify({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-contact-read.js'));
  } else if (action === 'chat_contact_manage') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    const settings = await openContactSettings({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      attemptId: phaseAttemptId(p.attemptId,
        p.confirm === true ? 'contact-manage-confirm-settings' : 'contact-manage-preview-settings'),
    });
    if (settings?.ok !== true || settings?.opened !== true) {
      res = { ...settings, phase: 'open-exact-contact-settings', exactTargetEvidence: false };
    } else {
      await cdp.evaluate(`window.__chatContactManage=${JSON.stringify({
        targetCompany: p.targetCompany,
        targetCompanyId: p.targetCompanyId,
        action: p.contactAction,
        attemptId: p.attemptId,
        confirm: p.confirm === true,
      })}; ${setId} return 1`);
      const managed = await cdp.evaluate(page('chat-contact-manage.js'));
      res = {
        ...managed,
        preview: p.confirm !== true && managed?.ok === true,
        exactTargetEvidence: managed?.ok === true,
        preparationClicks: 1,
        persistentMutationClicks: p.confirm === true && managed?.clickedOnce === true ? 1 : 0,
      };
    }
  } else if (action === 'chat_contact_note') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    const phaseId = phaseAttemptId(p.attemptId,
      p.confirm === true ? 'contact-note-confirm' : 'contact-note-preview');
    const settings = await openContactSettings({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      attemptId: phaseAttemptId(phaseId, 'settings'),
    });
    if (settings?.ok !== true || settings?.opened !== true) {
      res = { ...settings, phase: 'open-exact-contact-settings', exactTargetEvidence: false };
    } else {
      const editor = await openContactPhase({
        targetCompany: p.targetCompany,
        targetCompanyId: p.targetCompanyId,
        attemptId: phaseId,
        action: 'note_open',
      });
      if (editor?.ok !== true || editor?.verified !== true) {
        res = { ...editor, phase: 'open-phase-bound-private-note', exactTargetEvidence: false };
      } else {
        await cdp.evaluate(`window.__chatContactNote=${JSON.stringify({
          targetCompany: p.targetCompany,
          targetCompanyId: p.targetCompanyId,
          note: p.note,
          attemptId: phaseId,
          confirm: p.confirm === true,
        })}; ${setId} return 1`);
        const note = await cdp.evaluate(page('chat-contact-note.js'));
        res = {
          ...note,
          attemptId: p.attemptId,
          preview: p.confirm !== true && note?.ok === true,
          exactTargetEvidence: note?.ok === true,
          preparationClicks: 2,
          persistentMutationClicks: p.confirm === true && note?.clickedOnce === true ? 1 : 0,
        };
      }
    }
  } else if (action === 'chat_contact_report') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    const phaseId = phaseAttemptId(p.attemptId,
      p.confirm === true ? 'contact-report-confirm' : 'contact-report-preview');
    const settings = await openContactSettings({
      targetCompany: p.targetCompany,
      targetCompanyId: p.targetCompanyId,
      attemptId: phaseAttemptId(phaseId, 'settings'),
    });
    if (settings?.ok !== true || settings?.opened !== true) {
      res = { ...settings, phase: 'open-exact-contact-settings', exactTargetEvidence: false };
    } else {
      const warning = await openContactPhase({
        targetCompany: p.targetCompany,
        targetCompanyId: p.targetCompanyId,
        attemptId: phaseId,
        action: 'report_prepare',
      });
      if (warning?.ok !== true || warning?.verified !== true) {
        res = { ...warning, phase: 'open-phase-bound-report-warning', exactTargetEvidence: false };
      } else {
        await cdp.evaluate(`window.__chatContactReport=${JSON.stringify({
          targetCompany: p.targetCompany,
          targetCompanyId: p.targetCompanyId,
          attemptId: phaseId,
          confirm: p.confirm === true,
        })}; ${setId} return 1`);
        const report = await cdp.evaluate(page('chat-contact-report.js'));
        res = {
          ...report,
          attemptId: p.attemptId,
          preview: p.confirm !== true && report?.ok === true,
          exactTargetEvidence: report?.ok === true,
          preparationClicks: 2,
          persistentMutationClicks: p.confirm === true && report?.clickedOnce === true ? 1 : 0,
        };
      }
    }
  } else if (action === 'chat_subscription_list') {
    await cdp.goto('https://www.simcompanies.com/account-settings/chatrooms/' + p.realmId + '/');
    await cdp.evaluate(`window.__chatSubscriptionList=${JSON.stringify({ realmId: p.realmId })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-subscription-list.js'));
  } else if (action === 'chat_subscription_toggle') {
    await cdp.goto('https://www.simcompanies.com/account-settings/chatrooms/' + p.realmId + '/');
    await cdp.evaluate(`window.__chatSubscriptionToggle=${JSON.stringify({
      realmId: p.realmId,
      dbLetter: p.dbLetter,
      name: p.name,
      subscribe: p.subscribe,
      attemptId: p.attemptId,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-subscription-toggle.js'));
  } else if (action === 'chat_message_translate') {
    await cdp.goto('https://www.simcompanies.com/messages/' + encodeURIComponent(p.targetCompany) + '/');
    await cdp.evaluate(`window.__chatMessageTranslate=${JSON.stringify({
      targetCompany: p.targetCompany,
      sourceText: p.sourceText,
      attemptId: p.attemptId,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-message-translate.js'));
  } else if (action === 'chat_message_retract') {
    await cdp.goto('https://www.simcompanies.com/messages/chatroom_' + encodeURIComponent(p.room) + '/');
    const phaseId = phaseAttemptId(p.attemptId,
      p.confirm === true ? 'message-retract-confirm' : 'message-retract-preview');
    await cdp.evaluate(`window.__chatMessageRetractPrepare=${JSON.stringify({
      room: p.room,
      sourceText: p.sourceText,
      attemptId: phaseId,
      // Opening the confirmation is a reversible UI preparation step. The persistent
      // retraction remains gated by the top-level confirm bit and exact same-wake preview.
      confirm: true,
    })}; ${setId} return 1`);
    const prepared = await cdp.evaluate(page('chat-message-retract-prepare.js'));
    if (prepared?.ok !== true || prepared?.opened !== true) {
      res = { ...prepared, phase: 'open-phase-bound-retract-warning', exactTargetEvidence: false };
    } else {
      await cdp.evaluate(`window.__chatMessageRetractConfirm=${JSON.stringify({
        room: p.room,
        sourceText: p.sourceText,
        attemptId: phaseId,
        confirm: p.confirm === true,
      })}; ${setId} return 1`);
      const retracted = await cdp.evaluate(page('chat-message-retract-confirm.js'));
      res = {
        ...retracted,
        attemptId: p.attemptId,
        preview: p.confirm !== true && retracted?.ok === true,
        exactTargetEvidence: retracted?.ok === true,
        preparationClicks: 1,
        persistentMutationClicks: p.confirm === true && retracted?.clickedOnce === true ? 1 : 0,
      };
    }
  } else if (action === 'chat_contract_list') {
    await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/incoming-contracts/');
    await cdp.evaluate(`window.__chatContractList=${JSON.stringify({ limit: p.limit })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-contract-list.js'));
  } else if (action === 'chat_contract_preview') {
    await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/incoming-contracts/');
    await cdp.evaluate(`window.__chatContractPreview=${JSON.stringify({
      contractId: p.contractId,
      ownCompanyId: p.ownCompanyId,
      terms: p.terms,
      termsHash: p.termsHash,
      confirm: false,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-contract-preview.js'));
  } else if (action === 'robots') {
    // Install robots: 3% WAGE cut only (no production bonus), locks the building to ONE product,
    // blocks upgrade/downgrade, uninstall refunds 50% at Q0 (board/.probe-robots.md). Dry reads
    // cost/needs/options; confirm installs; buyMissing:true is a SEPARATE money-spending flag.
    await cdp.goto(B(p.buildingId));
    const cash = await exactCashSnapshot();
    const specializationName = p.specialization ? canonName(p.specialization) : null;
    const specializationKind = specializationName
      ? (KIND_OF[specializationName] ?? exchangeKindFromName(p.specialization))
      : null;
    await cdp.evaluate(`window.__evaluateSpendGuard=${evaluateSpendGuard.toString()}; window.__buildingHasRobotSpecialization=${buildingHasRobotSpecialization.toString()}; window.__robots=${JSON.stringify({
      buildingId: p.buildingId,
      specialization: p.specialization || null,
      specializationKind,
      confirm: p.confirm === true,
      buyMissing: p.buyMissing === true,
      maxCost: p.maxCost,
      minCashAfter: Math.max(500, Number(p.minCashAfter ?? CFG.minCash ?? 800)),
      cash,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('robots.js'));
    if (p.confirm === true && res?.commitClicked === true) {
      const afterBuildings = await captureBuildings(B(p.buildingId));
      const verified = buildingHasRobotSpecialization(
        afterBuildings,
        p.buildingId,
        p.specialization,
        specializationKind,
      );
      res = { ...res, ok: verified, installed: verified, verified, doNotRetry: !verified,
        reason: verified ? undefined
          : 'Install robots was clicked but the exact building specialization was not authoritatively verified; do not retry blindly' };
    }
  } else if (action === 'contract_accept') {
    await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/incoming-contracts/');
    await cdp.evaluate(`window.__chatContractAccept=${JSON.stringify({
      contractId: p.contractId,
      termsHash: p.termsHash,
      evidenceFingerprint: p.evidenceFingerprint,
      previewId: p.previewId,
      economicPreviewId: p.economicPreviewId,
      attemptId: p.attemptId,
      preview: p.preview,
      authorization: p.authorization,
      confirm: p.confirm === true,
    })}; ${setId} return 1`);
    res = await cdp.evaluate(page('chat-contract-accept.js'));
  } else if (action === 'contract_send') {
    // Warehouse SEND CONTRACT via the standalone real-mouse driver (tile + quality-lot rows
    // ignore synthetic clicks). Dry fills + dumps + cancels; the final SEND CONTRACT
    // (btn-primary, same label as the opener — excluded by identity) needs confirm:true.
    const args = [path.join(ACTIONS, 'contract-send.js'),
      JSON.stringify({ name: p.name, company: p.company, qty: p.qty, price: p.price, lot: p.lot || 0, confirm: p.confirm === true })];
    const out = require('child_process').execFileSync('node', args, { cwd: DIR, timeout: 130000, encoding: 'utf8' });
    console.log(out.trim().split('\n').pop());
    cdp.close(); process.exit(0);
  } else if (action === 'auction_info') {
    // Building auctions: READ-ONLY. actions/auction.js has NO confirm path at all (send-to-auction
    // is irreversible — 24h Vickrey, 20% fee, no cancel; verified execution tooling is required).
    await cdp.goto('https://www.simcompanies.com/landscape/');
    await cdp.evaluate(`window.__auction=${JSON.stringify({ kind: p.kind ?? null, limit: p.limit ?? 15, confirm: p.confirm === true })}; ${setId} return 1`);
    res = await cdp.evaluate(page('auction.js'));
  } else {
    res = { ok: false, reason: 'unknown action: ' + action };
  }
  if (p.confirm === false && res && res.ok === false && /^dry run\b/i.test(String(res.reason || ''))) {
    res = { ...res, ok: true, dry: true, preview: true, note: res.reason };
    delete res.reason;
  }
  if (action === 'produce' && ownerBridgeAuthorization && res?.started === true) {
    res.ownerBridgeRecorded = markOwnerBridgeStarted(
      path.join(AUTOPILOT, 'OWNER-DIRECTIVE.json'),
      ownerBridgeAuthorization.directiveId,
      {
        quantity: res.effectiveQty,
        durationSeconds: res.durationSeconds,
        startedAtMs: Date.now(),
        finishBefore: ownerBridgeAuthorization.finishBefore,
      },
    );
  }
  res = auditEconomicCommunicationOutcome(res);
  console.log(JSON.stringify(res));
  cdp.close(); process.exit(0);   // open ws keeps node alive -> caller timeout would kill us
})().catch(e => {
  let result = { ok: false, reason: String(e.message || e).slice(0, 300) };
  if (chatEconomicAuthorization) {
    // Once authorization is consumed, an exception may have happened before or after the single
    // browser click. Record it as ambiguous and never replay the exact attempt.
    result = auditEconomicCommunicationOutcome({
      ...result,
      mutationAttempted: true,
      ambiguous: true,
      doNotRetry: true,
    });
  }
  console.log(JSON.stringify(result));
  try { cdp.close(); } catch (x) {}
  process.exit(0);
});
