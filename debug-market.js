// Set a quantity, then list every button (text + disabled) to see what BUY becomes.
const inp = all('input').find(i => /quantity/i.test(i.placeholder || ''));
if (!inp) return { ok: false, reason: 'no quantity input', url: location.href };
setInput(inp, 5000);
inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
await sleep(1800);
return {
  url: location.href,
  value: inp.value,
  btns: all('button').map(b => ({
    text: norm(b.innerText).slice(0, 60), disabled: b.disabled, visible: b.offsetParent !== null,
  })).filter(b => b.text),
};
