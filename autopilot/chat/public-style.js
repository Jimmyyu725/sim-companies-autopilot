'use strict';

const DEFAULT_BODY_MAX_CHARACTERS = 45;
const MIN_BODY_MAX_CHARACTERS = 18;
const MAX_BODY_MAX_CHARACTERS = 45;
const MAX_LEARNED_BODY_MAX_CHARACTERS = 30;
const MAX_STYLE_SAMPLES = 120;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u00a0\u202f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function unicodeLength(value) {
  return Array.from(value).length;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function ratio(count, total) {
  return total > 0 ? Number((count / total).toFixed(3)) : 0;
}

function exactIso(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('observedAt must be a valid timestamp');
  return new Date(parsed).toISOString();
}

function buildPublicStyleProfile(messages, {
  roomId,
  observedAt = new Date(),
  maxSamples = MAX_STYLE_SAMPLES,
} = {}) {
  const room = normalizeText(roomId);
  if (!room || room.length > 160) throw new TypeError('roomId must be a bounded non-empty string');
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > MAX_STYLE_SAMPLES) {
    throw new TypeError(`maxSamples must be between 1 and ${MAX_STYLE_SAMPLES}`);
  }
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');

  const samples = [];
  for (const message of messages) {
    if (!plainObject(message) || message.conversationType !== 'room'
        || normalizeText(message.conversationId) !== room || message.direction !== 'inbound') continue;
    const text = normalizeText(message.content?.text);
    if (!text || /[\r\n]/u.test(String(message.content?.text ?? ''))) continue;
    const resourceKinds = Array.isArray(message.content?.resourceMentions)
      ? message.content.resourceMentions
        .map(entry => Number(entry?.kind))
        .filter(kind => Number.isSafeInteger(kind) && kind > 0)
      : [];
    samples.push({ text, resourceKinds });
    if (samples.length >= maxSamples) break;
  }

  const lengths = samples.map(sample => unicodeLength(sample.text)).sort((a, b) => a - b);
  const medianCharacters = percentile(lengths, 0.5);
  const p75Characters = percentile(lengths, 0.75);
  const recommendedBodyMaxCharacters = samples.length >= 3
    ? Math.max(MIN_BODY_MAX_CHARACTERS, Math.min(MAX_LEARNED_BODY_MAX_CHARACTERS, p75Characters))
    : DEFAULT_BODY_MAX_CHARACTERS;
  const counts = {
    resourceIcon: samples.filter(sample => sample.resourceKinds.length > 0).length,
    quantity: samples.filter(sample => /(?:^|\s)\d+(?:[.,]\d+)?\s*[kmb]?(?:\s|$)/iu.test(sample.text)).length,
    quality: samples.filter(sample => /(?:^|\s)q\s*\d+(?:\s|$)/iu.test(sample.text)).length,
    price: samples.filter(sample => /(?:@\s*(?:\$|mp|q)?\s*[+-]?\d|\$\s*\d|[+-]\s*\d+\s*%?\s*mp)/iu.test(sample.text)).length,
    intent: samples.filter(sample => /\b(?:buy|buying|sell|selling|wtb|wts|need|offer)\b/iu.test(sample.text)).length,
  };

  return Object.freeze({
    schemaVersion: 1,
    status: samples.length >= 3 ? 'learned' : 'insufficient-samples',
    roomId: room,
    observedAt: exactIso(observedAt),
    sampleSize: samples.length,
    rawExamplesIncluded: false,
    medianCharacters,
    p75Characters,
    recommendedBodyMaxCharacters,
    featureRates: Object.freeze({
      resourceIcon: ratio(counts.resourceIcon, samples.length),
      quantity: ratio(counts.quantity, samples.length),
      quality: ratio(counts.quality, samples.length),
      price: ratio(counts.price, samples.length),
      intent: ratio(counts.intent, samples.length),
    }),
    recommendedShape: Object.freeze([
      'intent', 'quantity', 'resource-icon', 'quality', 'price',
    ]),
  });
}

function validatePublicStyleProfile(value, { roomId = null } = {}) {
  if (!plainObject(value) || value.schemaVersion !== 1
      || !['learned', 'insufficient-samples'].includes(value.status)
      || typeof value.roomId !== 'string' || !value.roomId.trim()
      || !Number.isFinite(Date.parse(value.observedAt))
      || !Number.isSafeInteger(value.sampleSize) || value.sampleSize < 0
      || value.sampleSize > MAX_STYLE_SAMPLES || value.rawExamplesIncluded !== false
      || !Number.isSafeInteger(value.recommendedBodyMaxCharacters)
      || value.recommendedBodyMaxCharacters < MIN_BODY_MAX_CHARACTERS
      || value.recommendedBodyMaxCharacters > MAX_BODY_MAX_CHARACTERS
      || (value.status === 'learned'
        && value.recommendedBodyMaxCharacters > MAX_LEARNED_BODY_MAX_CHARACTERS)
      || (value.status === 'insufficient-samples'
        && value.recommendedBodyMaxCharacters !== DEFAULT_BODY_MAX_CHARACTERS)
      || !plainObject(value.featureRates)
      || !Array.isArray(value.recommendedShape)
      || value.recommendedShape.join(',') !== 'intent,quantity,resource-icon,quality,price') {
    return false;
  }
  if (roomId != null && normalizeText(value.roomId) !== normalizeText(roomId)) return false;
  for (const key of ['resourceIcon', 'quantity', 'quality', 'price', 'intent']) {
    if (!Number.isFinite(value.featureRates[key])
        || value.featureRates[key] < 0 || value.featureRates[key] > 1) return false;
  }
  for (const valueOrNull of [value.medianCharacters, value.p75Characters]) {
    if (valueOrNull != null && (!Number.isSafeInteger(valueOrNull) || valueOrNull < 1)) return false;
  }
  return true;
}

module.exports = {
  DEFAULT_BODY_MAX_CHARACTERS,
  MAX_BODY_MAX_CHARACTERS,
  MAX_LEARNED_BODY_MAX_CHARACTERS,
  MAX_STYLE_SAMPLES,
  MIN_BODY_MAX_CHARACTERS,
  buildPublicStyleProfile,
  validatePublicStyleProfile,
};
