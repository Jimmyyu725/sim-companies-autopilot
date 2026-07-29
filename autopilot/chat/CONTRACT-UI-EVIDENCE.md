# Chat-to-contract UI evidence and acceptance boundary

Last static review: 2026-07-27. This review did not connect to CDP, click a live contract, send a
contract, or mutate the game.

## Evidence read

- `bundle-main.js` (6,960,304 bytes; local mtime 2026-07-23 00:48:31 -0500).
- `legacy/board/workflow/.probe-contracts.md` and the five retained dry probe scripts.
- `autopilot/actions/contract-send.js`, the three `chat-contract-*.js` rendered-UI fragments,
  `autopilot/act.js`, and `autopilot/chat/contract-gate.js`.

The relevant static bundle locations are byte offsets in this exact local bundle, not stable source
line numbers:

- Route declaration at byte 687967:
  `/headquarters/warehouse/incoming-contracts/`.
- Contract row component `oBr` starts at byte 2471290. Its root is a `div` with `tabIndex=0` and an
  aria-label containing direction, quantity, localized resource name, quality, unit price, displayed
  total, and counterparty company.
- That rendered root has no `id`, `data-contract-id`, contract URL, or other explicit contract-ID
  attribute. The contract ID is only a React key (`f.id`), which React does not render into DOM.
- The `ble` grouping component starts at byte 2476673. Identical kind/price/quantity/quality/party
  contracts may be grouped into one row, making term-only row identity unsafe.
- The accept control has aria-label `Sign contract` (byte 2476077). Its handler (byte 2471464)
  immediately signs ordinary contracts but opens another confirmation modal when
  `needsConfirmation` is true. The rendered row does not expose `needsConfirmation` as a stable
  DOM attribute.
- The empty incoming list renders the localized `Warehouse.empty` string; the English default is
  `Wow! Such empty`.

The exact English row aria-label template in the same bundle is:

```text
incoming contract, {quantity} {resourceName} quality {quality}, at ${price} per unit,
total price ${totalPrice}, from {company}
```

The displayed total is calculated by the bundle as:

```text
ceil(trunc(quantity * unitPrice * 1000) / 1000)
```

## What is safe now

- `chat-contract-list.js` reads the already-rendered English incoming-contract page without any
  click or network call. It only reports loaded rows or the exact loaded empty state.
- `chat-contract-preview.js` is `confirm:false`, zero-click, and requires an exact rendered contract
  ID plus explicit resource/counterparty IDs before it can issue a preview artifact. The current
  bundle does not provide those attributes, so it reliably returns `unsupported` instead of matching
  by terms or row order.
- Every external contract row is evidence only. Chat text cannot authorize tools or contracts.
- The central dispatcher exposes these reads as `chat_contract_list` and
  `chat_contract_preview`. The legacy `contract_accept` boundary refuses before browser access and
  reports caller-supplied IDs as unverified rather than reviving the historical API-backed reader.

## Why acceptance remains disabled

Acceptance cannot meet the required exact-ID and one-click proof on the current UI:

1. The DOM does not expose contract ID, resource kind ID, counterparty company ID, or the
   `needsConfirmation` boolean.
2. Identical offers can be grouped into one row.
3. `Sign contract` is not a uniform preview control: one branch mutates immediately and the other
   branch opens a second modal.
4. No live incoming row has been safely captured, so the success acknowledgement and exact
   postcondition are unverified.

`chat-contract-accept.js` therefore validates `confirm:true`, the contract-gate authorization,
`termsHash`, preview integrity, expiry, idempotency key, one-click ceiling, and UI evidence
fingerprint, then refuses with zero clicks. It has no mutation path. Do not enable it until a real
incoming row is observed read-only and a stable explicit contract ID plus exact postcondition are
proven.

## Sending contracts

Do not create a second send path from chat. No private-chat `Send contract` UI control has been
observed. The warehouse flow is already mapped and guarded in `actions/contract-send.js`; chat
negotiation should hand exact, economically approved terms to that existing action. Its dry preview
selects the warehouse lot, fills the form, and cancels; its confirmed path requires the unique final
button and exact recipient/quantity/price. This module deliberately adds no sender.
