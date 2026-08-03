const r = await api('/api/v3/companies/auth-data/');
const a = r.json || {};
const c = a.authCompany || {};
return {
  productionModifier: c.productionModifier,
  salesModifier: c.salesModifier,
  extraBuildingSlots: c.extraBuildingSlots,
  extraExecutiveSlots: c.extraExecutiveSlots,
  simBoosts: c.simBoosts,
  exchangedToday: c.exchangedToday,
  rank: c.rank,
  courses: a.courses,
  temporals: a.temporals,
};
