// Set the PA reply choice for pages/pa-reply.js — "sales department wants a party" vignette (2026-07-24 15:30).
// Offer: "Boss, business is going well. The sales department wants to celebrate. Maybe we could
// organize something for them?" Options:
//  (1) "Yes, budget $3,000 for a party."
//  (2) "No time for parties at this moment, we should all focus on the business."
// Pure cash-sink vignette with NO stated return (pa-quests pattern #3 — decline cash-sinks;
// the earlier $500-1,500 party decline paid $0/no-penalty). $3,000 is 11% of cash and would
// push the 2nd-Mill gate further out. Decline. "no time for parties" uniquely matches option (2).
window.__paChoice = 'no time for parties';
return { set: window.__paChoice };
