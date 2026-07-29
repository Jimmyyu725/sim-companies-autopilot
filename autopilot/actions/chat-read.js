// Read ONE chat room. Caller must have navigated to the room's REAL URL
// (https://www.simcompanies.com/messages/chatroom_<Name>/ — probe .probe-chat.md §2: direct
// URLs give correct attribution; sidebar clicking races the pane render and mixes rooms up).
// Params: window.__chatroom = 'Game' | 'Help' | 'Sales' | 'Aerospace sales' | 'Social'.
// Pure read — never dismisses overlays or touches the composer.
const room = String(window.__chatroom || '');
if (!room) return { ok: false, reason: 'no window.__chatroom set' };
if (!decodeURIComponent(location.href).includes('chatroom_' + room))
  return { ok: false, reason: 'not on the requested room URL', room, href: location.href };

// Dismissing this overlay persists a preference, so a read-only action must fail closed.
const dismiss = byText('Ok, and do not show again').find(e => e.offsetParent !== null);
if (dismiss) return {
  ok: false,
  blockedByOverlay: true,
  reason: 'room rules overlay requires an explicit mutation; read-only action did not dismiss it',
};

const lines = document.body.innerText.split('\n').map(s => s.trim());
// Sidebar unread badges append digits to the room link text ("Sales 108").
const unread = {};
for (const l of lines) {
  const m = l.match(/^(Game|Help|Sales|Aerospace sales|Social)\s+(\d+)$/);
  if (m) unread[m[1]] = Number(m[2]);
}
// Pane header = room name in CAPS; messages follow until the bottom nav ("Map ...").
// Anchor on the LAST caps occurrence (the sidebar lists mixed-case names, header is caps).
const CAPS = room.toUpperCase();
let start = -1;
for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === CAPS) { start = i; break; }
if (start < 0) return { ok: false, reason: 'room header "' + CAPS + '" not found in pane', room,
                        unread, tail: lines.slice(-15).join(' | ').slice(0, 400) };
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) if (lines[i] === 'Map') { end = i; break; }
const messages = lines.slice(start + 1, end).filter(Boolean).join('\n');
return { ok: true, room, unread, messages: messages.slice(-2600) };
