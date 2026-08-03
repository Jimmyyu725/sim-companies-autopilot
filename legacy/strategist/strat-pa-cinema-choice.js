// Set the PA reply choice for pages/pa-reply.js — cinema pricing vignette (2026-07-24).
// Offer: friend's cinema, 1,000 seats, we get 50% of profits. Options:
//  (a) $1/seat full house  (b) $4/seat, 60% sold  (c) $2 over-60s + $4 others  (d) decline.
// (c) is price discrimination: it fills the price-elastic senior seats at $2 that $4 would
// leave empty while still charging $4 to inelastic buyers — strictly higher revenue than a
// single price, and profit is what we take 50% of. The "wise" branch is the rewarded one.
window.__paChoice = 'over 60s';
return { set: window.__paChoice };
