// Discover subscribed public rooms and the subscription-settings entry from the rendered UI.
// Pure DOM read: this fragment never clicks, navigates, or calls a chat API.
const visible = element => !!element && element.offsetParent !== null;
const clean = value => String(value || '')
  .replace(/[\u00a0\u202f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const parseDirectRoom = href => {
  try {
    const url = new URL(String(href || ''), location.origin);
    const match = url.pathname.match(/^\/messages\/chatroom_([^/]+)\/?$/i);
    if (!match) return null;
    const room = clean(decodeURIComponent(match[1]));
    if (!room) return null;
    return {
      room,
      url: `${url.origin}/messages/chatroom_${encodeURIComponent(room)}/`,
    };
  } catch {
    return null;
  }
};

const roomByUrl = new Map();
for (const anchor of all('a[href]')) {
  if (!visible(anchor)) continue;
  const parsed = parseDirectRoom(anchor.getAttribute('href'));
  if (!parsed) continue;
  const label = clean(anchor.innerText);
  const unreadMatch = label.match(/(?:^|\s)(\d+)$/);
  const candidate = {
    ...parsed,
    unread: unreadMatch ? Number(unreadMatch[1]) : 0,
    active: anchor.getAttribute('aria-current') === 'page',
  };
  const prior = roomByUrl.get(parsed.url);
  if (!prior || candidate.active || candidate.unread > prior.unread) {
    roomByUrl.set(parsed.url, candidate);
  }
}

const settingsLinks = all('a[href]').filter(anchor => {
  if (!visible(anchor)) return false;
  try {
    return new URL(anchor.getAttribute('href'), location.origin).pathname
      .includes('/account-settings/chatrooms/');
  } catch {
    return false;
  }
});
const settingsButtons = all('button').filter(button =>
  visible(button) && !!button.querySelector('svg[data-icon="gear"], svg[data-icon="cog"]'));

return {
  ok: roomByUrl.size > 0,
  rooms: [...roomByUrl.values()].sort((a, b) => a.room.localeCompare(b.room)),
  subscriptionEntry: settingsLinks.length === 1
    ? { type: 'link', href: settingsLinks[0].href }
    : settingsButtons.length === 1
      ? { type: 'button', icon: settingsButtons[0].querySelector('svg')?.dataset?.icon || null }
      : { type: 'UNKNOWN', linkCount: settingsLinks.length, buttonCount: settingsButtons.length },
  reason: roomByUrl.size ? undefined : 'no subscribed public-room links found in rendered UI',
};
