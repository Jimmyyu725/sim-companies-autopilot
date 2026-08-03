// Try a bonus code on the redeem page. Must already be on /redeem-bonus-code/.
// Param: window.__code (the code string). Returns the page's response message.
const code = window.__code;
const inp = all('input[name=code]')[0] || all('input')[0];
if (!inp) return { code, ok: false, reason: 'no code input' };

setInput(inp, code);
await sleep(800);
const btn = all('button').find(b => /REDEEM CODE/i.test(norm(b.innerText)) && !b.disabled);
if (!btn) return { code, ok: false, reason: 'no redeem button' };

const before = norm(document.body.innerText);
btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
await sleep(3500);
const after = norm(document.body.innerText);

// The response is whatever text appeared that wasn't there before, plus any toast/alert.
const newText = after.replace(before.slice(0, 200), '').slice(0, 300);
const success = /success|redeemed|congratulation|received|you got|added|granted/i.test(after) &&
                !/invalid|expired|already|not found|used|error|no longer/i.test(after.slice(-400));
const failure = /invalid|expired|already|not found|already been used|error|no longer valid/i.test(after);
return { code, success, failure, snippet: after.slice(-350) };
