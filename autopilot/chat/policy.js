'use strict';

const PUBLIC_REASONS = new Set([
  'direct-mention',
  'reply',
  'explicit-buy-request',
  'verified-offer',
  'material-update',
]);

const CHAT_POLICY = Object.freeze({
  schemaVersion: 1,
  operatingMode: 'autonomous-company-owner',
  decisionAuthority: Object.freeze({
    finalDecisionMaker: 'company-brain',
    humanApprovalRequired: false,
    internalEvidenceAndSafetyChecksRemainRequired: true,
  }),
  identity: Object.freeze({
    identityNeutral: true,
    neverClaimAI: true,
    neverClaimRobot: true,
    neverClaimAssistant: true,
    neverStateOwnName: true,
    neverImpersonateSpecificHuman: true,
    neverDeferToHumanOwnerOrResponsiblePerson: true,
  }),
  publicMessages: Object.freeze({
    maxCharacters: 60,
    maxLines: 1,
    maxPerHour: 3,
    maxPerDay: 12,
    proactiveRoomCooldownMs: 15 * 60 * 1000,
    duplicateCooldownMs: 24 * 60 * 60 * 1000,
  }),
  windowsSync: Object.freeze({
    privateMessages: false,
    privateSummaries: false,
    publicMessages: true,
    aggregateCounters: true,
  }),
});

const DEFAULT_HUMAN_NAMES = Object.freeze(['Jimmy', 'Jimmy Yu', 'Jay', '于京田']);
const ENGLISH_BUSINESS_SELF_STATUS = new Set([
  'able', 'available', 'building', 'buying', 'checking', 'closed', 'confirming',
  'interested', 'looking', 'offering', 'open', 'producing', 'ready', 'seeking',
  'selling', 'upgrading', 'waiting',
]);
const CHINESE_BUSINESS_SELF_PREFIXES = Object.freeze([
  '需要', '购买', '出售', '买', '卖', '供应', '生产', '寻找', '准备', '可以',
  '负责', '经营', '老板', '买家', '卖家', '供应商', '采购方', '出售方',
]);

const IDENTITY_PATTERNS = Object.freeze([
  { id: 'ai-disclosure', pattern: /\b(?:a\.?i\.?|artificial intelligence|large language model|language model|llm|gpt(?:-?\d+(?:\.\d+)*)?|chatgpt|openai)\b|人工智能|大模型|语言模型|模型驱动/iu },
  { id: 'automated-agent-disclosure', pattern: /\b(?:(?:this )?account is automated|bot|chatbot|assistant|virtual assistant|virtual agent|automation|automated agent|automated account)\b|聊天机器人|智能助手|虚拟助手|自动化账号|自动回复/iu },
  { id: 'ai-identity', pattern: /\b(?:i am|i'm|this is|speaking as|as)\s+(?:an?\s+)?(?:a\.?i\.?|artificial intelligence|language model|llm)\b|(?:我是|本账号是|作为)(?:一个)?(?:AI|人工智能|大模型|语言模型)/iu },
  { id: 'robot-identity', pattern: /\b(?:(?:i am|i'm|this is|this account is|speaking as|as)\s+(?:an?\s+)?(?:robot|scripted)|(?:robot|scripted)\s+(?:account|team|operator))\b|(?:我是|本账号是|作为)(?:一个)?(?:机器人|自动化|脚本)/iu },
  { id: 'assistant-identity', pattern: /\b(?:i am|i'm|this is|speaking as|as)\s+(?:an?\s+)?(?:assistant|virtual agent)\b|(?:我是|本账号是|作为)(?:一个)?(?:助手|虚拟助理)/iu },
  { id: 'own-name', pattern: /\b(?:my name is|my name's|call me)\b|我叫|我的名字(?:是|叫)|称呼我/iu },
  { id: 'human-deferral', pattern: /\b(?:ask|contact|wait for|forward (?:this )?to|pass (?:this )?to)\b.{0,50}\b(?:human|owner|boss|manager|person in charge)\b|\b(?:human|owner|boss|manager)\b.{0,30}\b(?:approval|confirmation)\b|转达|负责人|老板不在线|等待(?:老板|人工|负责人)|需要(?:人工|老板|负责人)(?:批准|确认)/iu },
]);

function unicodeLength(text) {
  return Array.from(text).length;
}

function normalizeFingerprint(text) {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function looksLikeSelfNameDisclosure(text) {
  const english = text.match(/^(?:I am|I'm|This is|i am|i'm|this is)\s+([A-Z][\p{L}'-]{1,39}(?:\s+[A-Z][\p{L}'-]{1,39}){0,2})(?=\s*(?:[,;:—.!?]|$))/u);
  if (english) {
    const phrase = english[1].trim();
    const firstWord = phrase.match(/^\p{L}+/u)?.[0]?.toLocaleLowerCase('en-US');
    if (!ENGLISH_BUSINESS_SELF_STATUS.has(firstWord)
        && phrase) {
      return true;
    }
  }
  const chinese = text.match(/^我是\s*([^，,。.!！?\n]{1,12})(?:[，,。.!！?]|$)/u);
  if (!chinese) return false;
  const phrase = chinese[1].trim();
  return /^[\p{Script=Han}]{2,4}$/u.test(phrase)
    && !CHINESE_BUSINESS_SELF_PREFIXES.some(prefix => phrase.startsWith(prefix));
}

function hasEconomicCommunicationLanguage(text) {
  const value = String(text || '').normalize('NFKC');
  return /(?:\$\s*\d|@\s*(?:\$?\s*\d|mp\b)|\bmp\s*[+-]\s*\d|\b(?:can supply|can buy|agreed|agree|accepted|confirmed|deal|sounds good|works for (?:me|us)|send (?:the )?contract|accept (?:the )?contract)\b|\b(?:buy|buying|sell|selling|supply|supplying|offer|offering|order|ordering|take|taking|wtb|wts)\b.{0,32}(?:\d|:re-\d+:)|\b(?:i(?:'ll| will| can| want to)?|we(?:'ll| will| can)?)\s+(?:take|buy|supply|sell|order)\s+\d)/iu.test(value);
}

function hasPrivateCommitmentLanguage(text) {
  return hasEconomicCommunicationLanguage(text);
}

function inspectOutgoingText(text, { scope = 'private', knownHumanNames = [] } = {}) {
  const violations = [];
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, violations: ['empty-message'], characters: 0 };
  }
  const trimmed = text.trim();
  for (const rule of IDENTITY_PATTERNS) {
    if (rule.pattern.test(trimmed)) violations.push(rule.id);
  }
  if (looksLikeSelfNameDisclosure(trimmed)) violations.push('invented-self-name');
  for (const name of [...DEFAULT_HUMAN_NAMES, ...knownHumanNames]) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const escaped = escapeRegex(name.trim());
    const selfClaim = new RegExp(`(?:\\b(?:i am|i'm|this is)\\s+${escaped}\\b|我是\\s*${escaped})`, 'iu');
    const speakerClaim = new RegExp(`(?:^|\\b)${escaped}\\s+(?:here|speaking)\\b`, 'iu');
    if (selfClaim.test(trimmed) || speakerClaim.test(trimmed)) {
      violations.push('specific-human-impersonation');
    }
  }
  const characters = unicodeLength(trimmed);
  if (scope === 'room') {
    if (/\r|\n/u.test(trimmed)) violations.push('public-must-be-one-line');
    if (characters > CHAT_POLICY.publicMessages.maxCharacters) violations.push('public-too-long');
  } else if (scope !== 'private') {
    violations.push('invalid-scope');
  }
  return {
    ok: violations.length === 0,
    violations: [...new Set(violations)],
    characters,
    normalizedText: trimmed,
  };
}

function parseTime(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp`);
  return parsed;
}

function evaluatePublicSend({
  text,
  roomId,
  reason,
  recentPublicMessages = [],
  now = new Date(),
  knownHumanNames = [],
}) {
  const inspection = inspectOutgoingText(text, { scope: 'room', knownHumanNames });
  if (!inspection.ok) return { ok: false, reason: inspection.violations.join(','), inspection };
  if (typeof roomId !== 'string' || !roomId.trim()) return { ok: false, reason: 'roomId-required', inspection };
  if (!PUBLIC_REASONS.has(reason)) return { ok: false, reason: 'concrete-public-reason-required', inspection };
  if (!Array.isArray(recentPublicMessages)) throw new TypeError('recentPublicMessages must be an array');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date');
  const recent = recentPublicMessages.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new TypeError(`recentPublicMessages[${index}] must be an object`);
    return {
      text: String(entry.text ?? ''),
      roomId: String(entry.roomId ?? ''),
      sentAtMs: parseTime(entry.sentAt, `recentPublicMessages[${index}].sentAt`),
    };
  }).filter(entry => entry.sentAtMs <= nowMs);
  const fingerprint = normalizeFingerprint(inspection.normalizedText);
  const duplicate = recent.find(entry => (
    nowMs - entry.sentAtMs <= CHAT_POLICY.publicMessages.duplicateCooldownMs
    && normalizeFingerprint(entry.text) === fingerprint
  ));
  if (duplicate) return { ok: false, reason: 'duplicate-public-message', inspection };

  const lastHour = recent.filter(entry => nowMs - entry.sentAtMs <= 60 * 60 * 1000);
  if (lastHour.length >= CHAT_POLICY.publicMessages.maxPerHour) {
    return { ok: false, reason: 'public-hourly-limit', inspection };
  }
  const lastDay = recent.filter(entry => nowMs - entry.sentAtMs <= 24 * 60 * 60 * 1000);
  if (lastDay.length >= CHAT_POLICY.publicMessages.maxPerDay) {
    return { ok: false, reason: 'public-daily-limit', inspection };
  }

  if (!['reply', 'direct-mention'].includes(reason)) {
    const lastInRoom = recent
      .filter(entry => entry.roomId === roomId)
      .sort((left, right) => right.sentAtMs - left.sentAtMs)[0];
    if (lastInRoom && nowMs - lastInRoom.sentAtMs < CHAT_POLICY.publicMessages.proactiveRoomCooldownMs) {
      return { ok: false, reason: 'proactive-room-cooldown', inspection };
    }
  }
  return { ok: true, reason: 'allowed', inspection, fingerprint };
}

function windowsExportDecision({ recordType, conversationType }) {
  if (conversationType === 'private') {
    return { allowed: false, reason: 'private-chat-stays-on-nas-by-default' };
  }
  if (conversationType !== 'room') return { allowed: false, reason: 'unknown-conversation-type' };
  if (recordType === 'message') return { allowed: true, reason: 'public-message' };
  if (recordType === 'aggregate-counter') return { allowed: true, reason: 'non-private-aggregate' };
  return { allowed: false, reason: 'record-type-not-approved-for-windows' };
}

module.exports = {
  CHAT_POLICY,
  DEFAULT_HUMAN_NAMES,
  IDENTITY_PATTERNS,
  PUBLIC_REASONS,
  evaluatePublicSend,
  hasEconomicCommunicationLanguage,
  hasPrivateCommitmentLanguage,
  inspectOutgoingText,
  normalizeFingerprint,
  unicodeLength,
  windowsExportDecision,
};
