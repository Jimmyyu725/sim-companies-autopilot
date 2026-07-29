// Start a new private conversation through Search -> company profile -> envelope.
// Params: window.__chatPrivateStart = {
//   targetCompany, targetCompanyId?, targetRealmId, confirm
// }.
// Search and navigation use only rendered UI controls; this fragment performs no direct API call.
const privateStart = window.__chatPrivateStart || {};
const targetCompany = String(privateStart.targetCompany || '').normalize('NFKC').trim();
const targetCompanyId = Number(privateStart.targetCompanyId);
const targetRealmId = Number(privateStart.targetRealmId);
const idRequested = Number.isSafeInteger(targetCompanyId) && targetCompanyId > 0;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
const visible = element => !!element && element.offsetParent !== null;
const pathOf = href => {
  try { return decodeURIComponent(new URL(href, location.origin).pathname); } catch (_) { return ''; }
};

if (!targetCompany || targetCompany.length < 4) {
  return { ok: false, reason: 'targetCompany must contain at least four characters for UI search' };
}
if (!Number.isSafeInteger(targetRealmId) || targetRealmId < 0) {
  return { ok: false, reason: 'targetRealmId is required to bind the exact search result' };
}
if (!/^\/(?:[a-z]{2}\/)?search\/?$/i.test(location.pathname)) {
  return { ok: false, reason: 'navigate to the game Search page before starting a private thread', href: location.href };
}
const searchInputs = all('input[name="search"]').filter(visible);
if (searchInputs.length !== 1) {
  return { ok: false, reason: 'visible company search input count != 1', count: searchInputs.length };
}
if (privateStart.confirm !== true) {
  return {
    ok: true,
    dry: true,
    targetCompany,
    targetCompanyId: idRequested ? targetCompanyId : null,
    targetRealmId,
    note: 'confirmation will type into Search, open the exact company profile, then click its envelope',
  };
}

setInput(searchInputs[0], targetCompany);
let result = null;
let selectedProfilePath = '';
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(200);
  const expectedProfilePrefix = `/company/${targetRealmId}/`;
  const candidates = all('a').filter(visible).filter(anchor => {
    const bold = anchor.querySelector('b');
    const candidatePath = pathOf(anchor.href);
    return bold && equalFold(bold.textContent, targetCompany)
      && candidatePath.startsWith(expectedProfilePrefix)
      && new RegExp(`^/company/${targetRealmId}/[^/]+/?$`, 'u').test(candidatePath);
  });
  if (candidates.length === 1) {
    result = candidates[0];
    selectedProfilePath = pathOf(result.href);
    break;
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'exact search result is ambiguous', count: candidates.length };
  }
}
if (!result) return { ok: false, reason: 'exact company did not appear in UI search results' };

result.click();
let profileVerified = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(200);
  const headings = all('h1').filter(visible).filter(heading => equalFold(heading.textContent, targetCompany));
  if (pathOf(location.href).toLocaleLowerCase('en-US') === selectedProfilePath.toLocaleLowerCase('en-US')
      && headings.length === 1) {
    profileVerified = true;
    break;
  }
}
if (!profileVerified) {
  return {
    ok: false,
    navigationAttempted: true,
    doNotRetry: true,
    reason: 'search result clicked but exact profile URL/header was not verified',
  };
}

const expectedMessagePath = `/messages/${targetCompany}/`;
const envelopes = all('svg[data-icon="envelope"]').filter(visible)
  .map(icon => icon.closest('a'))
  .filter(Boolean)
  .filter((anchor, index, anchors) => anchors.indexOf(anchor) === index)
  .filter(anchor => pathOf(anchor.href).toLocaleLowerCase('en-US') === expectedMessagePath.toLocaleLowerCase('en-US'));
if (envelopes.length !== 1) {
  return { ok: false, reason: 'exact profile envelope count != 1', count: envelopes.length };
}

envelopes[0].click();
let destination = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(200);
  const pathname = pathOf(location.href);
  const routeMatch = pathname.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
  const route = routeMatch ? routeMatch[1] || '' : '';
  const headers = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
  const exactContacts = idRequested
    ? all(`#chat-contacts a.js-test-chat-contact-${targetCompanyId}`).filter(anchor => {
      if (!visible(anchor)) return false;
      const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
      return directDivs.length > 0 && equalFold(directDivs[0].textContent, targetCompany);
    })
    : [];
  const idVerified = exactContacts.length === 1;
  if ((route === targetCompany || route.startsWith(`${targetCompany}-chatroom_`))
      && headers.length === 1 && (!idRequested || idVerified)) {
    destination = { pathname, idVerified };
    break;
  }
}
if (!destination) {
  return {
    ok: false,
    navigationAttempted: true,
    doNotRetry: true,
    reason: 'profile envelope clicked but exact private destination was not verified',
  };
}
return {
  ok: true,
  opened: true,
  targetCompany,
  targetCompanyId: idRequested ? targetCompanyId : null,
  targetRealmId,
  idVerified: destination.idVerified,
  pathname: destination.pathname,
};
