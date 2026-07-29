const r = await api('/api/v3/companies/auth-data/');
const a = r.json || {};
const out = { levelInfo: a.levelInfo, keys: Object.keys(a) };
out.companyFields = a.authCompany ? Object.keys(a.authCompany) : [];
// look for anything specialization-shaped
for (const k of out.companyFields) {
  if (/special|focus|prod|sale|trade|bonus|perk/i.test(k)) out['co.' + k] = a.authCompany[k];
}
return out;
