// Set the PA reply choice for pages/pa-reply.js (kept in a file to avoid shell-quoting the string).
// 2026-07-23 18:40 CDT — "yearly fair" offer: 2,500 apples @ $4.50 vs 1,200 sausages @ $14.30.
// Answering with goods we do not hold is the measured-safe branch (pa-quests.md): it returns
// "You do not have N x" and leaves the offer OPEN, so this keeps a possibly +$4,030 option
// alive at zero cash cost instead of declining it while the Slaughterhouse gate is 1.5h away.
window.__paChoice = '2,500 apples';
return { set: window.__paChoice };
