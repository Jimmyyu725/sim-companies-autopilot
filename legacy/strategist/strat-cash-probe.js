// Minimal cash/level read used to measure the exact delta a one-off action produces.
const a = await api('/api/v3/companies/auth-data/');
const c = (a.json || {}).authCompany || {};
const r = await api('/api/v3/resources/5714348/');
const transport = ((r.json || []).filter(x => x.kind === 13).reduce((s, x) => s + x.amount, 0));
return { status: a.status, money: c.money, level: c.level, xp: c.xp, transport };
