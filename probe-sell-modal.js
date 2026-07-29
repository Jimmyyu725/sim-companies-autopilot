#!/usr/bin/env node
// READ-ONLY probe: open a warehouse resource's modal (real mouse click — React ignores
// synthetic clicks on these tiles) and dump its buttons/inputs/text so we can see the
// exchange-sell form. Does NOT submit anything. Usage: node probe-sell-modal.js <imgname>
const cdp = require('./cdp.js');
const imgname = process.argv[2] || 'gold-watch';
(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');
  const box = await cdp.evaluate(`
    const img = all('img').find(i => new RegExp(${JSON.stringify(imgname)}).test(i.src||''));
    if (!img) return null;
    let el = img; for (let k=0;k<5 && el.parentElement;k++){ if (el.getBoundingClientRect().width>40) break; el=el.parentElement; }
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };`);
  if (!box) { console.log(JSON.stringify({ ok:false, reason:'tile not found' })); cdp.close(); process.exit(1); }
  for (const type of ['mousePressed','mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button:'left', clickCount:1 });
  await new Promise(r => setTimeout(r, 2600));
  const modal = await cdp.evaluate(`
    const btns = all('button').filter(b=>b.offsetParent!==null).map(b=>norm(b.innerText)).filter(Boolean);
    const inputs = all('input').filter(i=>i.offsetParent!==null).map(i=>({type:i.type,ph:i.placeholder,name:i.name,val:String(i.value).slice(0,10)}));
    const sellish = all('a,div[role=button],span,li,button').filter(e=>/sell|exchange|offer|post/i.test(norm(e.innerText))&&e.offsetParent!==null).map(e=>norm(e.innerText).slice(0,34));
    return { url:location.href, btns:btns.slice(0,30), inputs, sellish:[...new Set(sellish)].slice(0,15), text: norm(document.body.innerText).slice(-700) };`);
  console.log(JSON.stringify({ ok:true, clickedAt:box, modal }, null, 2));
  cdp.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
