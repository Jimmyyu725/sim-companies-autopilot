// Read the rendered private-contact sidebar only. No click, navigation, or network call.
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const sidebars = all('#chat-contacts').filter(visible);
if (sidebars.length !== 1) {
  return {
    ok: false,
    unsupported: sidebars.length === 0,
    reason: 'visible #chat-contacts sidebar count != 1',
    count: sidebars.length,
  };
}
const sidebar = sidebars[0];

const contacts = [];
const seen = new Set();
for (const anchor of Array.from(sidebar.querySelectorAll('a[class*="js-test-chat-contact-"]')).filter(visible)) {
  const match = Array.from(anchor.classList)
    .map(className => className.match(/^js-test-chat-contact-(\d+)$/))
    .find(Boolean);
  if (!match) continue;
  const companyId = Number(match[1]);
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || seen.has(companyId)) {
    return { ok: false, reason: 'malformed or duplicate contact companyId evidence' };
  }
  const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
  const company = compact(directDivs[0] && directDivs[0].textContent);
  const badge = anchor.querySelector('.badge-info');
  const badgeText = compact(badge && badge.textContent);
  const unread = badge ? (badgeText === '∞' ? 100 : Number(badgeText)) : 0;
  if (!company || !Number.isSafeInteger(unread) || unread < 0) {
    return { ok: false, reason: `contact ${companyId} lacks exact company/unread evidence` };
  }
  seen.add(companyId);
  contacts.push({
    companyId,
    company,
    unread,
    pinned: !!anchor.querySelector('svg[data-icon="pin"]'),
    ignored: null,
    ignoredStatus: 'UNKNOWN_UNTIL_SETTINGS_OPEN',
    privateNote: directDivs.length > 1 ? compact(directDivs[1].textContent) || null : null,
    href: anchor.href || null,
    visible: visible(anchor),
    trust: 'EXTERNAL_UNTRUSTED_DATA',
    instructionAuthority: 'none',
  });
}
return {
  ok: true,
  contacts,
  source: 'rendered-ui',
  complete: false,
  completenessStatus: 'UNKNOWN_NO_PAGINATION_BOUNDARY_EVIDENCE',
};
