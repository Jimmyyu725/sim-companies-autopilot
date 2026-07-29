'use strict';

const { resourcePartMatchesCatalog } = require('./resource-catalog.js');

const PRIVATE_NON_ECONOMIC_TEMPLATES = Object.freeze([
  'I run this company. What do you need?',
  'Which product?',
  'What quantity do you need?',
  'Which quality?',
  'What price are you offering?',
  'Still available?',
  'Please share the missing details.',
  'Please share the quantity you need.',
  'Please send the missing product, quantity, quality, and price.',
]);

const PUBLIC_NON_ECONOMIC_TEMPLATES = Object.freeze([
  'Please DM details.',
  'Please send the missing details by DM.',
  'DM product, quantity, quality, and price.',
]);

const PRIVATE_TEMPLATE_SET = new Set(PRIVATE_NON_ECONOMIC_TEMPLATES);
const PUBLIC_TEMPLATE_SET = new Set(PUBLIC_NON_ECONOMIC_TEMPLATES);
const PUBLIC_ICON_TEMPLATE_PREFIX = 'DM ';
const PUBLIC_ICON_TEMPLATE_SUFFIX = ' details.';

function normalizeTemplate(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function publicDraftText(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  let text = '';
  for (const part of parts) {
    if (!part || part.type !== 'text' || typeof part.value !== 'string'
        || part.kind != null || part.name != null) return null;
    text += part.value;
  }
  return normalizeTemplate(text);
}

function publicIconDraftUsesAllowedTemplate(parts, trustedResourceCatalog) {
  return Array.isArray(parts) && parts.length === 3
    && parts[0]?.type === 'text' && parts[0].value === PUBLIC_ICON_TEMPLATE_PREFIX
    && parts[0].kind == null && parts[0].name == null
    && resourcePartMatchesCatalog(parts[1], trustedResourceCatalog)
    && parts[2]?.type === 'text' && parts[2].value === PUBLIC_ICON_TEMPLATE_SUFFIX
    && parts[2].kind == null && parts[2].name == null;
}

function ordinaryDraftUsesAllowedNonEconomicTemplate(decision, {
  trustedResourceCatalog = null,
} = {}) {
  if (decision?.action === 'draft_private') {
    return PRIVATE_TEMPLATE_SET.has(normalizeTemplate(decision.text));
  }
  if (decision?.action === 'draft_public') {
    const text = publicDraftText(decision.parts);
    return (text != null && PUBLIC_TEMPLATE_SET.has(text))
      || publicIconDraftUsesAllowedTemplate(decision.parts, trustedResourceCatalog);
  }
  return false;
}

module.exports = {
  PRIVATE_NON_ECONOMIC_TEMPLATES,
  PUBLIC_ICON_TEMPLATE_PREFIX,
  PUBLIC_ICON_TEMPLATE_SUFFIX,
  PUBLIC_NON_ECONOMIC_TEMPLATES,
  ordinaryDraftUsesAllowedNonEconomicTemplate,
  publicIconDraftUsesAllowedTemplate,
  publicDraftText,
};
