// Save one private note through an already-open, phase-bound Private note modal.
// The textarea is never touched during preview; confirmation clicks Change exactly once.
const request = window.__chatContactNote || {};
const targetCompany = String(request.targetCompany || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const targetCompanyId = Number(request.targetCompanyId);
const attemptId = String(request.attemptId || '').trim();
const note = typeof request.note === 'string' ? request.note.normalize('NFKC').replace(/\r\n?/g, '\n') : null;
const visible = element => !!element && element.offsetParent !== null;
const compact = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
if (!targetCompany || !Number.isSafeInteger(targetCompanyId) || targetCompanyId <= 0 || note == null) {
  return { ok: false, reason: 'targetCompany, targetCompanyId, and note are required' };
}
if (note.length > 2000) return { ok: false, reason: 'private note exceeds 2000 characters' };
if (!/^[A-Za-z0-9._:-]{8,100}$/u.test(attemptId)) {
  return { ok: false, reason: 'attemptId must be an opaque 8-100 character identifier' };
}
let phase = null;
try { phase = JSON.parse(sessionStorage.getItem(`sim-chat-contact-phase:${attemptId}`) || 'null'); } catch (_) {}
if (!phase || phase.kind !== 'note' || phase.targetCompanyId !== targetCompanyId || phase.targetCompany !== targetCompany) {
  return { ok: false, unsupported: true, reason: 'exact private-note phase binding is missing' };
}

const noteHeaders = Array.from(document.querySelectorAll('*')).filter(visible)
  .filter(element => compact(element.textContent) === 'Private note');
const candidates = [];
for (const header of noteHeaders) {
  let modal = header.parentElement;
  while (modal && modal !== document.body) {
    const areas = Array.from(modal.querySelectorAll('textarea')).filter(visible);
    const buttons = Array.from(modal.querySelectorAll('button')).filter(visible)
      .filter(button => compact(button.innerText) === 'Change');
    if (areas.length === 1 && buttons.length === 1) {
      candidates.push({ modal, textarea: areas[0], button: buttons[0] });
      break;
    }
    modal = modal.parentElement;
  }
}
const unique = candidates.filter((candidate, index) => candidates.findIndex(other => other.modal === candidate.modal) === index);
if (unique.length !== 1) {
  return { ok: false, unsupported: true, reason: 'exact private-note modal count != 1', count: unique.length };
}
if (request.confirm !== true) {
  return {
    ok: true,
    dry: true,
    targetCompany,
    targetCompanyId,
    currentNote: String(unique[0].textarea.value || ''),
    wouldSave: note,
  };
}
let prior = null;
const storageKey = `sim-chat-contact-note-save:${attemptId}`;
try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
if (prior && prior.clicked === true) return { ok: false, doNotRetry: true, reason: 'attemptId already clicked Change' };
setInput(unique[0].textarea, note);
await sleep(150);
if (String(unique[0].textarea.value || '') !== note || unique[0].button.disabled) {
  return { ok: false, reason: 'private-note textarea/button did not retain an exact savable value' };
}
try { sessionStorage.setItem(storageKey, JSON.stringify({ clicked: true, targetCompanyId })); }
catch (_) { return { ok: false, reason: 'replay guard could not be persisted; Change was not clicked' }; }
unique[0].button.click();

let verified = false;
const expectedSidebar = compact(note).slice(0, 32);
for (let attempt = 0; attempt < 30; attempt += 1) {
  await sleep(150);
  const row = document.querySelector(`#chat-contacts a.js-test-chat-contact-${targetCompanyId}`);
  const directDivs = row ? Array.from(row.children).filter(child => child.tagName === 'DIV') : [];
  const renderedNote = directDivs.length > 1 ? compact(directDivs[1].textContent) : '';
  const editorStillOpen = Array.from(document.querySelectorAll('*')).filter(visible)
    .some(element => compact(element.textContent) === 'Private note');
  verified = !!row && !editorStillOpen && renderedNote === expectedSidebar;
  if (verified) break;
}
return verified
  ? { ok: true, verified: true, clickedOnce: true, targetCompany, targetCompanyId, privateNotePreview: expectedSidebar }
  : {
      ok: false,
      ambiguous: true,
      doNotRetry: true,
      reason: 'Change clicked once but note close/sidebar postcondition was not proven',
    };
