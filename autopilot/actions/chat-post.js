// Post ONE message to the chat room the caller navigated to (real URL
// /messages/chatroom_<Name>/ — .probe-chat.md §2). Self-gating like scrap.js:
// Params: window.__chatpost = { room, text, confirm }.
// Without confirm:true it verifies the room + composer and returns WITHOUT touching anything.
// It REFUSES (returns, never guesses) on any ambiguity — see .probe-chat.md §4 spec.
// Company conduct rules (§5: identity-neutral, real prices, no spam) are enforced by act.js + BRAIN.md;
// this file only guarantees the mechanical safety of the click.
const { room, text, confirm } = window.__chatpost || {};
const ROOMS = ['Game', 'Help', 'Sales', 'Aerospace sales', 'Social'];
if (!ROOMS.includes(room)) return { ok: false, reason: 'room must be one of ' + ROOMS.join('/') };
if (!decodeURIComponent(location.href).includes('chatroom_' + room))
  return { ok: false, reason: 'not on the requested room URL', room, href: location.href };
const t = String(text || '');
if (!t.trim()) return { ok: false, reason: 'empty text' };
if (t.length > 300) return { ok: false, reason: 'text > 300 chars — keep chat terse', len: t.length };
if (/^[@:]/.test(t.trim()))
  return { ok: false, reason: 'text starts with @ or : — opens a suggestion popup (probe §3); reword' };

// Dismissing this overlay persists a preference. This legacy preview never mutates it.
const dismiss = byText('Ok, and do not show again').find(e => e.offsetParent !== null);
if (dismiss) return {
  ok: false,
  blockedByOverlay: true,
  reason: 'room rules overlay requires an explicit mutation; legacy preview did not dismiss it',
};

// Composer: exactly ONE visible textarea (probe §3 — no id/name/class; placeholder is unique).
const areas = all('textarea[placeholder^="Type here"]').filter(e => e.offsetParent !== null);
if (areas.length !== 1)
  return { ok: false, reason: 'visible composer textarea count != 1', count: areas.length };
// Send button: identify ONLY via svg[data-icon="paper-plane"], require exactly one (probe §3).
const senders = all('button').filter(b =>
  b.offsetParent !== null && b.querySelector('svg[data-icon="paper-plane"]'));
if (senders.length !== 1)
  return { ok: false, reason: 'paper-plane send button count != 1', count: senders.length };

if (confirm !== true)
  return { ok: true, dry: true, room, wouldPost: t,
           note: 'composer + send button located; pass confirm:true to post' };

return {
  ok: false,
  reason: 'legacy chat posting is permanently disabled; use chat_room_post with a durable attemptId',
};
