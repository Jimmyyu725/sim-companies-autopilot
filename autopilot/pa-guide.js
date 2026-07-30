'use strict';

const crypto = require('node:crypto');

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'boss', 'by', 'choice', 'company', 'for',
  'from', 'gives', 'in', 'is', 'it', 'of', 'on', 'one', 'option', 'or', 'our',
  'reported', 'result', 'sir', 'the', 'their', 'this', 'to', 'unit', 'units',
  'wants', 'with',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[$€£¥]/gu, ' ')
    .replace(/[^\p{L}\p{N}.%+-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stem(token) {
  if (/^\d+(?:\.\d+)?$/u.test(token)) return token;
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function meaningfulTokens(value) {
  return [...new Set(normalize(value).split(' ')
    .map(stem)
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token)))];
}

function parseMarkdownTable(markdown) {
  const rows = [];
  for (const rawLine of String(markdown || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
    if (cells.length < 2 || cells.every(cell => /^:?-{3,}:?$/u.test(cell))) continue;
    const cue = cells[0];
    const outcome = cells.slice(1).join(' | ');
    if (!cue || /^offer(?:\s+and\s+chosen\s+response|\s+cue)?$/iu.test(cue)) continue;
    rows.push({ cue, outcome });
  }
  return rows;
}

function matchScore(offerText, cue) {
  const offer = normalize(offerText);
  const normalizedCue = normalize(cue);
  if (!offer || !normalizedCue) return 0;
  if (offer.includes(normalizedCue) || normalizedCue.includes(offer)) return 1;

  const cueTokens = meaningfulTokens(cue);
  const offerTokens = new Set(meaningfulTokens(offerText));
  if (!cueTokens.length || !offerTokens.size) return 0;
  const shared = cueTokens.filter(token => offerTokens.has(token));
  if (!shared.length) return 0;
  const coverage = shared.length / cueTokens.length;
  const specificity = shared.reduce((total, token) => total + Math.min(token.length, 12), 0)
    / cueTokens.reduce((total, token) => total + Math.min(token.length, 12), 0);
  const distinctive = shared.some(token => token.length >= 6);
  if (!distinctive && shared.length < 2) return 0;
  return Math.round((0.7 * coverage + 0.3 * specificity) * 1000) / 1000;
}

function rankedMatches(markdown, offerText, source, limit = 3) {
  return parseMarkdownTable(markdown)
    .map(row => ({ ...row, source, score: matchScore(offerText, row.cue) }))
    .filter(row => row.score >= 0.45)
    .sort((left, right) => right.score - left.score || left.cue.localeCompare(right.cue))
    .slice(0, limit);
}

function consultPaGuides({ offerText, communityGuide, measuredGuide, limit = 3 }) {
  const community = rankedMatches(communityGuide, offerText, 'community-reported', limit);
  const measured = rankedMatches(measuredGuide, offerText, 'locally-measured', limit);
  const digest = crypto.createHash('sha256')
    .update(String(communityGuide || ''))
    .update('\u0000')
    .update(String(measuredGuide || ''))
    .digest('hex');
  return {
    digest,
    community,
    measured,
    matchCount: community.length + measured.length,
  };
}

module.exports = {
  consultPaGuides,
  matchScore,
  meaningfulTokens,
  normalize,
  parseMarkdownTable,
  rankedMatches,
};
