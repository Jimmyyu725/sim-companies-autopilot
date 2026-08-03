// Read-only build-dialog probe: what does the game actually quote for a candidate building?
// confirm:false makes pages/build.js return the live quote before it clicks anything, so
// nothing is spent (skeptic rule, DOCTRINE §0).
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.js');
const page = (f) => fs.readFileSync(path.join(__dirname, 'pages', f), 'utf8');
const want = process.argv.slice(2);

(async () => {
  await cdp.connect();
  for (const b of want) {
    await cdp.goto('https://www.simcompanies.com/landscape/');
    await new Promise(r => setTimeout(r, 4000));
    await cdp.evaluate(`window.__build=${JSON.stringify({
      building: b, maxCost: 90000, minCashAfter: 5000, confirm: false })}; return 1`);
    const r = await cdp.evaluate(page('build.js'));
    console.log(b, JSON.stringify(r).slice(0, 400));
  }
  cdp.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
