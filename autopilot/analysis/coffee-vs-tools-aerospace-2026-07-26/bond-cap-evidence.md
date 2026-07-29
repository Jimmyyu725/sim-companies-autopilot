# Bond capacity evidence

- The user-provided Finance screenshot showed `$165,000` in the unsold-offer cash field while the
  current sold-bond records totalled `$110,000`.
- The current game bundle computes remaining bond units as
  `floor(sum(building.cost * building.size) / 5000) - soldUnits`, then multiplies by `$5,000`.
- The screenshot therefore supports an optimistic current ceiling of `$165,000` new offers and
  `$275,000` total exposure at that captured building state.
- This is not proof of available cash. `actions/bonds-adjust.js` currently reports the requested
  form value after clicking Update without re-reading the saved form or server response. Later dry
  reads returned zero, and no sale proceeds appeared in cash. Offer persistence and sale timing are
  therefore unverified.
