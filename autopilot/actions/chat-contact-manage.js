// Execute one UI step in an already-open exact contact settings modal.
// Supported steps: pin, unpin, hide, ignore, unignore, note_open, report_prepare.
// Each confirmed invocation clicks exactly one rendered control and verifies its UI transition.
const request = window.__chatContactManage || {};
const action = String(request.action || '');
const allowed = ['pin', 'unpin', 'hide', 'ignore', 'unignore', 'note_open', 'report_prepare'];
const targetCompany = String(request.targetCompany || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const targetCompanyId = Number(request.targetCompanyId);
const attemptId = String(request.attemptId || '').trim();
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const equalFold = (left, right) => compact(left).toLocaleLowerCase('en-US') === compact(right).toLocaleLowerCase('en-US');
if (!allowed.includes(action)) return { ok: false, unsupported: true, reason: 'unsupported contact settings action' };
if (!targetCompany || !Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0) {
  return { ok: false, reason: 'targetCompany and targetCompanyId are required' };
}
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}

const headers = Array.from(document.querySelectorAll('#chat-portal *')).filter(visible)
  .filter(element => equalFold(element.textContent, `${targetCompany} Settings`));
if (headers.length !== 1) return { ok: false, reason: 'exact target settings header count != 1', count: headers.length };
let modal = headers[0].parentElement;
while (modal && modal.id !== 'chat-portal') {
  if (modal.querySelector('svg[data-icon="pin"]')
      && modal.querySelector('svg[data-icon="ban"]')
      && modal.querySelector('svg[data-icon="flag"]')) break;
  modal = modal.parentElement;
}
if (!modal || modal.id === 'chat-portal') {
  return { ok: false, unsupported: true, reason: 'exact contact settings modal could not be scoped' };
}

const specifications = {
  pin: { icon: 'pin', text: `Pin conversation with ${targetCompany} to the top.` },
  unpin: { icon: 'pin', text: `Unpin conversation with ${targetCompany}.` },
  hide: { icon: 'eye-slash', text: `Hide conversation with ${targetCompany}.` },
  ignore: { icon: 'ban', text: `Ignore messages from ${targetCompany}.` },
  unignore: { icon: 'ban', text: `Messages from ${targetCompany} are ignored.` },
  note_open: { icon: 'edit', text: `Edit private note about ${targetCompany}` },
  report_prepare: { icon: 'flag', text: `Report conversation with ${targetCompany} as being against Terms & Conditions` },
};
const specification = specifications[action];
const icons = Array.from(modal.querySelectorAll(`svg[data-icon="${specification.icon}"]`));
const controls = [];
for (const icon of icons) {
  let node = icon;
  for (let depth = 0; node && node !== modal && depth < 7; depth += 1, node = node.parentElement) {
    if (compact(node.innerText) === specification.text) {
      controls.push(node);
      break;
    }
  }
}
const uniqueControls = controls.filter((control, index) => controls.indexOf(control) === index);
if (uniqueControls.length !== 1) {
  return {
    ok: false,
    unsupported: true,
    reason: 'exact semantic contact control count != 1',
    count: uniqueControls.length,
    action,
  };
}
if (request.confirm !== true) {
  return { ok: true, dry: true, action, targetCompany, targetCompanyId, wouldClick: specification.text };
}
const storageKey = `sim-chat-contact-manage:${attemptId}`;
let prior = null;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked' };
try {
  sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, action, targetCompany, targetCompanyId }));
} catch (_) {
  return { ok: false, reason: 'replay guard could not be persisted; action was not clicked' };
}

uniqueControls[0].click();
let verified = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(150);
  const row = document.querySelector(`#chat-contacts a.js-test-chat-contact-${targetCompanyId}`);
  if (action === 'pin') verified = !!row && !!row.querySelector('svg[data-icon="pin"]');
  else if (action === 'unpin') verified = !!row && !row.querySelector('svg[data-icon="pin"]');
  else if (action === 'hide') verified = !row;
  else if (action === 'ignore') verified = compact(document.body.innerText).includes(`Messages from ${targetCompany} are ignored.`);
  else if (action === 'unignore') verified = compact(document.body.innerText).includes(`Ignore messages from ${targetCompany}.`);
  else if (action === 'note_open') {
    const noteHeaders = Array.from(document.querySelectorAll('*')).filter(visible)
      .filter(element => compact(element.textContent) === 'Private note');
    verified = noteHeaders.length === 1 && Array.from(document.querySelectorAll('textarea')).filter(visible).length >= 1;
  } else if (action === 'report_prepare') {
    const reportButtons = Array.from(document.querySelectorAll('button')).filter(visible)
      .filter(button => compact(button.innerText) === 'Yes, report');
    verified = reportButtons.length === 1
      && compact(document.body.innerText).includes('You are about to report this conversation to moderators');
  }
  if (verified) break;
}
if (verified && (action === 'note_open' || action === 'report_prepare')) {
  try {
    sessionStorage.setItem(`sim-chat-contact-phase:${attemptId}`, JSON.stringify({
      kind: action === 'note_open' ? 'note' : 'report', targetCompany, targetCompanyId,
    }));
  } catch (_) {
    return {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'UI step succeeded but its exact phase binding could not be persisted',
    };
  }
}
return verified
  ? { ok: true, verified: true, clickedOnce: true, action, targetCompany, targetCompanyId }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'contact control clicked once but exact UI postcondition was not proven',
      action,
    };
