// Open one private conversation by clicking the envelope on an exact public message.
// Params: window.__chatPrivateOpen = {
//   room, targetCompany, targetCompanyId?, sourceText, confirm
// }.
// This fragment never calls a chat API. It follows the same visible envelope link a player uses.
const privateOpen = window.__chatPrivateOpen || {};
const targetCompany = String(privateOpen.targetCompany || '').normalize('NFKC').trim();
const sourceRoom = String(privateOpen.room || '').normalize('NFKC').trim();
const sourceText = String(privateOpen.sourceText || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const targetCompanyId = Number(privateOpen.targetCompanyId);
const idRequested = Number.isSafeInteger(targetCompanyId) && targetCompanyId > 0;
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
const parsedRoute = href => {
  try {
    const pathname = decodeURIComponent(new URL(href, location.origin).pathname);
    const match = pathname.match(/(?:^|\/)messages(?:\/([^/]+))?\/?$/i);
    return match ? { pathname, route: match[1] || '' } : null;
  } catch (_) {
    return null;
  }
};
const expectedEnvelopeRoute = `${targetCompany}-chatroom_${sourceRoom}`;

if (!targetCompany || !sourceRoom || !sourceText) {
  return { ok: false, reason: 'targetCompany, room, and exact sourceText are required' };
}
if (sourceText.length < 4) return { ok: false, reason: 'sourceText is too short to identify one public message' };
if (!decodeURIComponent(location.pathname).includes(`chatroom_${sourceRoom}`)) {
  return { ok: false, reason: 'not on the exact requested public room', href: location.href };
}

const envelopeAnchors = all('svg[data-icon="envelope"]')
  .filter(visible)
  .map(icon => icon.closest('a'))
  .filter(Boolean)
  .filter((anchor, index, anchors) => anchors.indexOf(anchor) === index)
  .filter(anchor => {
    const route = parsedRoute(anchor.href);
    return route && route.route === expectedEnvelopeRoute;
  });

const locateMessageGroup = anchor => {
  let node = anchor.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 10; depth += 1, node = node.parentElement) {
    const text = compact(node.innerText);
    if (!text.includes(sourceText)) continue;
    const exactCompanyLabel = Array.from(node.querySelectorAll('span,b,a,div'))
      .some(element => visible(element) && equalFold(element.textContent, targetCompany));
    if (exactCompanyLabel) return node;
  }
  return null;
};

const matches = envelopeAnchors
  .map(anchor => ({ anchor, group: locateMessageGroup(anchor) }))
  .filter(candidate => candidate.group);
if (matches.length !== 1) {
  return {
    ok: false,
    reason: 'exact public message envelope count != 1',
    count: matches.length,
    routeMatches: envelopeAnchors.length,
  };
}

const match = matches[0];
const sourceResourceKinds = Array.from(match.group.querySelectorAll('img[alt^=":re-"]'))
  .map(image => compact(image.getAttribute('alt')).match(/^:re-(\d+):$/))
  .filter(Boolean)
  .map(iconMatch => Number(iconMatch[1]))
  .filter((kind, index, kinds) => Number.isSafeInteger(kind) && kind > 0 && kinds.indexOf(kind) === index);

if (privateOpen.confirm !== true) {
  return {
    ok: true,
    dry: true,
    targetCompany,
    targetCompanyId: idRequested ? targetCompanyId : null,
    envelopeHref: match.anchor.href,
    sourceResourceKinds,
  };
}

match.anchor.click();
let destination = null;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await sleep(200);
  const route = parsedRoute(location.href);
  const headers = all('.well-header').filter(visible).filter(header => equalFold(header.textContent, targetCompany));
  const contactRecords = all('#chat-contacts a[class*="js-test-chat-contact-"]').map(anchor => {
    const classMatch = Array.from(anchor.classList)
      .map(className => className.match(/^js-test-chat-contact-(\d+)$/))
      .find(Boolean);
    const directDivs = Array.from(anchor.children).filter(child => child.tagName === 'DIV');
    return classMatch && directDivs.length
      ? { companyId: Number(classMatch[1]), company: compact(directDivs[0].textContent) }
      : null;
  }).filter(Boolean);
  const routeMatches = route && (route.route === targetCompany || route.route.startsWith(`${targetCompany}-chatroom_`));
  const exactContacts = idRequested
    ? contactRecords.filter(contact => contact.companyId === targetCompanyId
      && equalFold(contact.company, targetCompany))
    : [];
  const idVerified = exactContacts.length === 1;
  if (routeMatches && headers.length === 1 && (!idRequested || idVerified)) {
    destination = { route, header: compact(headers[0].textContent), contactRecords, idVerified };
    break;
  }
}
if (!destination) {
  return {
    ok: false,
    navigationAttempted: true,
    doNotRetry: true,
    reason: 'envelope clicked but the exact private destination was not verified',
    targetCompany,
    targetCompanyId: idRequested ? targetCompanyId : null,
  };
}
return {
  ok: true,
  opened: true,
  targetCompany,
  targetCompanyId: idRequested ? targetCompanyId : null,
  idVerified: destination.idVerified,
  pathname: destination.route.pathname,
  sourceResourceKinds,
};
