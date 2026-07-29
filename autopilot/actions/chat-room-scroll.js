// Scroll the exact public-room pane to load older rendered messages or return to the newest edge.
// The game may fetch history as a consequence of normal UI scrolling; this fragment makes no API call.
const request = window.__chatRoomScroll || {};
const room = String(request.room || '').trim();
const direction = request.direction || 'older';
if (!room) return { ok: false, reason: 'room is required' };
if (!['older', 'newest'].includes(direction)) {
  return { ok: false, reason: 'direction must be older or newest' };
}

const visible = element => !!element && element.offsetParent !== null;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const roomHrefMatches = href => {
  try {
    const path = decodeURIComponent(new URL(String(href || ''), location.origin).pathname)
      .toLocaleLowerCase('en-US');
    const wanted = room.toLocaleLowerCase('en-US');
    return path.includes(`-chatroom_${wanted}`) || path.includes(`/chatroom_${wanted}`);
  } catch {
    return false;
  }
};
const exactHeaders = root => all('*').filter(element => root.contains(element)
  && visible(element)
  && !element.querySelector('textarea')
  && clean(element.innerText).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));
const scrollersIn = root => all('div').filter(element => {
  if (!root.contains(element) || !visible(element)) return false;
  const style = getComputedStyle(element);
  return style.flexDirection === 'column-reverse'
    && ['auto', 'scroll'].includes(style.overflowY);
});

const matches = [];
for (const textarea of all('textarea[placeholder^="Type here"]')) {
  if (!visible(textarea)) continue;
  let ancestor = textarea.parentElement;
  while (ancestor && ancestor !== document.body) {
    const localAreas = all('textarea[placeholder^="Type here"]')
      .filter(element => visible(element) && ancestor.contains(element));
    const roomIcon = all('img[alt]').some(image => ancestor.contains(image)
      && visible(image)
      && clean(image.alt).toLocaleLowerCase('en-US') === room.toLocaleLowerCase('en-US'));
    const roomConversation = all('a[href]').some(anchor => ancestor.contains(anchor)
      && visible(anchor)
      && roomHrefMatches(anchor.getAttribute('href')));
    const scrollers = scrollersIn(ancestor);
    if (localAreas.length === 1 && exactHeaders(ancestor).length > 0
        && (roomIcon || roomConversation) && scrollers.length === 1) {
      matches.push({ pane: ancestor, scroller: scrollers[0] });
      break;
    }
    ancestor = ancestor.parentElement;
  }
}
if (matches.length !== 1) {
  return { ok: false, reason: 'exact public-room pane count != 1', room, paneCount: matches.length };
}

const { pane, scroller } = matches[0];
const groupCount = () => {
  const roots = [];
  for (const icon of all('svg[data-icon="envelope"]')) {
    if (!pane.contains(icon) || !visible(icon)) continue;
    const link = icon.closest('a[href]');
    const inner = icon.closest('div.invisible-possible');
    const root = inner?.parentElement;
    if (link && roomHrefMatches(link.getAttribute('href')) && root && !roots.includes(root)) roots.push(root);
  }
  return roots.length;
};
const metrics = () => ({
  scrollTop: Number(scroller.scrollTop),
  scrollHeight: Number(scroller.scrollHeight),
  clientHeight: Number(scroller.clientHeight),
  groupCount: groupCount(),
});
const boundary = values => ({
  atNewest: values.scrollTop >= -2,
  atOldest: Math.abs(values.scrollTop) + values.clientHeight >= values.scrollHeight - 2,
});

const before = metrics();
const beforeBoundary = boundary(before);
if ((direction === 'older' && beforeBoundary.atOldest)
    || (direction === 'newest' && beforeBoundary.atNewest)) {
  return { ok: true, room, direction, boundary: true, changed: false, before, after: before };
}

const target = direction === 'older' ? -Math.max(before.scrollHeight, 1) : 0;
if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: target, behavior: 'auto' });
else scroller.scrollTop = target;

let after = metrics();
for (let attempt = 0; attempt < 16; attempt += 1) {
  await sleep(500);
  after = metrics();
  const edge = boundary(after);
  if (after.scrollHeight !== before.scrollHeight
      || after.groupCount !== before.groupCount
      || (direction === 'older' ? edge.atOldest : edge.atNewest)) break;
}
const afterBoundary = boundary(after);
const changed = after.scrollHeight !== before.scrollHeight
  || after.groupCount !== before.groupCount
  || after.scrollTop !== before.scrollTop;

return {
  ok: changed || (direction === 'older' ? afterBoundary.atOldest : afterBoundary.atNewest),
  room,
  direction,
  changed,
  boundary: direction === 'older' ? afterBoundary.atOldest : afterBoundary.atNewest,
  before,
  after,
  reason: changed ? undefined : 'scroll produced no observable UI transition',
};
