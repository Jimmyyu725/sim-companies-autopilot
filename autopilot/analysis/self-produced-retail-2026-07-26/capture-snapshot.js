'use strict';

const fs = require('fs');
const path = require('path');
const cdp = require(path.join(__dirname, '..', '..', '..', 'shared', 'cdp.js'));

const COMPANY_ID = 5714348;

(async () => {
  await cdp.connect();
  const snapshot = await cdp.evaluate(`
    const [retail, weather, modifiers, company, auth] = await Promise.all([
      api('/api/v4/0/resources-retail-info/'),
      api('/api/v2/weather/0/'),
      api('/api/v2/production-modifiers/0/'),
      api('/api/v3/companies/${COMPANY_ID}/'),
      api('/api/v3/companies/auth-data/'),
    ]);
    const companyInfo = company.json?.companyPublicInfo || {};
    const infrastructure = company.json?.infrastructure || {};
    const authCompany = auth.json?.authCompany || {};
    return {
      capturedAtUtc: new Date().toISOString(),
      statuses: {
        retail: retail.status,
        weather: weather.status,
        modifiers: modifiers.status,
        company: company.status,
        auth: auth.status,
      },
      company: {
        level: companyInfo.level,
        administrationOverhead: infrastructure.administrationOverhead,
        permanentProductionModifierPercent: authCompany.productionModifier,
        permanentSalesModifierPercent: authCompany.salesModifier,
        baseMaximumBuildings: Number(companyInfo.maxBuildings || 0),
        extraBuildingSlots: Number(authCompany.extraBuildingSlots || 0),
        maximumBuildings: Number(companyInfo.maxBuildings || 0) + Number(authCompany.extraBuildingSlots || 0),
        standardBuildings: Array.isArray(infrastructure.buildings)
          ? infrastructure.buildings.filter(item => !item.freeAndLocked).length
          : null,
      },
      weather: weather.json,
      productionModifiers: modifiers.json?.resourceProductionModifiers || [],
      retail: Array.isArray(retail.json) ? retail.json.map(item => ({
        kind: item.dbLetter,
        quality: item.quality,
        averagePrice: item.averagePrice ?? null,
        saturation: item.saturation ?? null,
        demand: Array.isArray(item.retailData) && item.retailData.length
          ? item.retailData[item.retailData.length - 1].demand ?? null
          : null,
      })) : null,
    };
  `);
  fs.writeFileSync(
    path.join(__dirname, 'market-snapshot.json'),
    JSON.stringify(snapshot, null, 2) + '\n',
    'utf8',
  );
  console.log(JSON.stringify({
    ok: Object.values(snapshot.statuses).every(status => status === 200),
    capturedAtUtc: snapshot.capturedAtUtc,
    retailRows: Array.isArray(snapshot.retail) ? snapshot.retail.length : 0,
    statuses: snapshot.statuses,
  }));
  cdp.close();
  process.exit(0);
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  try { cdp.close(); } catch (_) {}
  process.exit(1);
});
