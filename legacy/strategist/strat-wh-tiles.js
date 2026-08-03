// List warehouse tiles with the image name sell-exchange-ui.js matches on, so a surplus
// sell can target the right tile by regex instead of guessing the label.
const imgs = all('img').filter(i => i.offsetParent !== null).map(i => {
  const src = i.src || '';
  const base = (src.split('/').pop() || '').split('?')[0];
  let el = i; for (let k = 0; k < 5 && el.parentElement; k++) { if (el.getBoundingClientRect().width > 40) break; el = el.parentElement; }
  return { img: base, near: norm(el.innerText).slice(0, 60) };
}).filter(x => x.img && !/logo|avatar|flag/i.test(x.img));
return { url: location.href, count: imgs.length, tiles: imgs.slice(0, 40) };
