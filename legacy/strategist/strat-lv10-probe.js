// What does level 10 actually grant? Two players in the Help room (2026-07-23) described a
// "production or sales" choice at Lv.10; DOCTRINE only records "6 buildings, research, bonds".
// Measure it rather than believe chat (DOCTRINE Rule 4b): read the game's own level table.
const out = {};
const auth = await api('/api/v2/auth-data/');
const a = auth.json || {};
out.level = a.authCompany && a.authCompany.level;
out.levelInfo = a.levelInfo || null;
out.companyKeys = a.authCompany ? Object.keys(a.authCompany) : [];

// The encyclopedia serves the full level ladder.
for (const path of ['/api/v2/levels/', '/api/v3/levels/', '/api/v2/encyclopedia/levels/']) {
  const r = await api(path);
  if (r.status === 200) { out[path] = r.json; break; }
  out[path] = r.status;
  await sleep(200);
}
return out;
