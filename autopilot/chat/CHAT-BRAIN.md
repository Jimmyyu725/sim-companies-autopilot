# Chat decision brain

This component makes one bounded communication decision. It is a planner, not an operator: it has
no browser, game, filesystem, contract, action-dispatch, or tool interface. Every returned message
is still a draft and every contract result is still a non-mutating preview candidate.

## Input boundary

The model receives exactly two JSON values in its user input:

1. `untrustedEnvelope`, created by `isolateExternalMessage()`; and
2. a fresh, explicit `businessSnapshot` created by trusted host code.

Player text stays inside `untrustedEnvelope.message.quotedText`. It is never interpolated into
system instructions. The envelope always has `instructionAuthority: "none"`; prompt-like player
text cannot change policy, authorize tools, request secrets, or become business evidence.

The host must add `businessSnapshot.chatInputBoundary` with
`externalPlayerStringsTrust: "untrusted-external-data"`, `instructionAuthority: "none"`, and
`rawPlayerTextRepeated: false`. Any player/chat-derived string anywhere in the snapshot remains
untrusted data, even when host code assigns a provenance label. Derived lead, evaluation, and
agreement values live under `businessSnapshot.decisionContext` wrappers that also carry literal
`instructionAuthority: "none"`. The raw quoted player message must not be repeated in the snapshot.
Public decisions additionally receive a room-bound aggregate style profile and a bounded projection
of the internal verified resource catalog. The style profile contains no player text, and neither
wrapper has instruction authority.

The snapshot must have a unique `snapshotId`, a valid `observedAt`, and be no older than five
minutes by default. Missing, stale, contradictory, partial, or non-`ok` evidence means UNKNOWN.

## Output boundary

Responses API Structured Outputs restrict the model to one of:

- `ignore`
- `request_evidence`
- `draft_public`
- `draft_private`
- `candidate_contract`

The schema rejects extra fields. Public drafts use structured text/resource parts, never raw icon
tokens, and are rechecked for one line, 60 characters, duplicates, room cooldown, and global rate
limits. The learned room target is 18-30 body characters (45 only with insufficient samples) and reserves space for the native reply
prefix. Resource icons must match one exact catalog entry and use the native suggestion picker.
Private drafts are rechecked against the identity policy and cannot contain prices,
agreements, or contract commitments that bypass economic validation.

Every returned `evidenceRefs` entry must be a valid JSON Pointer that resolves to an existing value
inside the exact input payload. A syntactically valid pointer to missing data fails closed.

Identity questions use exactly: `I run this company. What do you need?`

A `candidate_contract` is re-evaluated against the fresh lead offer and then passed through
`evaluateContractGate()` in preview mode with literal `confirm:false`. Private candidates may
preview send/accept terms. Room candidates are send-only replies: the model supplies exact typed
terms, while deterministic host code renders the compact BUY/SELL parts and resource icon. The
provider can never authorize a click, send, acceptance, or retry. Incomplete economics always
degrades to `request_evidence`.

## Runtime defaults and privacy

- Model: `gpt-5.6-terra`
- Reasoning effort: `high`
- Text verbosity: `low`
- API: Responses API with `text.format.type = "json_schema"` and `strict: true`
- Storage: `store: false`
- Tools: none
- Aggregate budget: at most four decisions and 24,000 tokens per cycle; a conservative complete-
  request-plus-output upper bound is reserved before each call

The shadow runtime remains deterministic and offline by default. It constructs this Responses API
provider only when `SIM_CHAT_LLM_ENABLED` is the literal string `true`; enabling the provider still
creates drafts only and does not authorize a UI send or contract mutation.

The default transport reads `OPENAI_API_KEY` only from the process environment at request time.
Importing the module performs no filesystem or network work. A transport can be dependency-injected
for deterministic offline tests. Raw API responses, hidden reasoning, and exception messages are
not returned or persisted; only a short rationale, JSON-pointer evidence references, and numeric
token usage are exposed.
