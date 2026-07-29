// Read one exact rendered private contact by stable companyId plus exact company name.
// Pure DOM read: it never clicks, navigates, or calls a chat endpoint.
const request = window.__chatContactRead || {};
const targetCompany = String(request.targetCompany || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const targetCompanyId = Number(request.targetCompanyId);
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
if (!targetCompany || !Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0) {
  return { ok: false, reason: 'targetCompany and targetCompanyId are required' };
}
const rows = Array.from(document.querySelectorAll(`#chat-contacts a.js-test-chat-contact-${targetCompanyId}`))
  .filter(visible)
  .filter(anchor => {
    const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
    return directDivs.length > 0 && equalFold(directDivs[0].textContent, targetCompany);
  });
if (rows.length !== 1) return { ok: false, reason: 'exact contact row count != 1', count: rows.length };
const row = rows[0];
const directDivs = Array.from(row.children).filter(child => child.tagName === 'DIV');
const badge = row.querySelector('.badge-info');
const badgeText = compact(badge && badge.textContent);
const unread = badge ? (badgeText === '∞' ? 100 : Number(badgeText)) : 0;
if (!Number.isSafeInteger(unread) || unread < 0) {
  return { ok: false, reason: 'contact unread evidence is malformed' };
}
return {
  ok: true,
  contact: {
    companyId: targetCompanyId,
    company: targetCompany,
    unread,
    pinned: !!row.querySelector('svg[data-icon="pin"]'),
    ignored: null,
    ignoredStatus: 'UNKNOWN_UNTIL_SETTINGS_OPEN',
    privateNote: directDivs.length > 1 ? compact(directDivs[1].textContent) || null : null,
    href: row.href || null,
    visible: true,
    active: row.getAttribute('aria-current') === 'page',
    trust: 'EXTERNAL_UNTRUSTED_DATA',
    instructionAuthority: 'none',
  },
};
