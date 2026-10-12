# Changelog

All notable changes to `@execuro-sw-ecosystem/sw-tender-discovery-tool`.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Answering a client question queues the answer.** Picking an option adds one `decision` entry (`action: answer`) to the Queued (n) block, counted in `Send (n)`; the card shows "✓ answer queued" with an undo, updates in place (no scroll jump, no reload) and keeps the selection across a reload. The runtime applies it with the other queued decisions on Send; an answer that fails is logged and posted to the chat.

- **The partner profile lives in `var/`.** `var/sw-ai-sdk/tender/partner-profile.md` under the project root — one profile per checkout, shared by every tender, gitignored through Shopware's `/var/*` — instead of `specs/rfp-partner-profile.md`, which a tracked copy could clobber. An old `specs/` file is still read (`GET /api/profile` says `legacy: true`) until the next save writes the new location; `GET /api/profile` returns `path`, and the wizard shows it.

- **Analyze chunks hold up to 45 items** (was about 15).

### Fixed

- **No re-queue loop.** A `*` re-estimate mark now walks the document
  (items already written since the mark are skipped) and clears; a `reopened`
  item applied unchanged is not queued again until the operator changes it or
  a per-item mark names it.
- **No duplicate client questions.** `apply` reuses an existing CQ with the
  same normalised text and an overlapping item set, unions item ids into it,
  appends an item reported `blockedBy` an existing CQ, and never re-blocks an
  item on an answered one.

### Added

- **The running batch is marked in the chat.** Each batch bubble shows its live
  state from the run and the queue: `working` (pulsing dot, stage, elapsed
  time), `queued`, `done` or `aborted`; the working bubble is highlighted. The
  `run` event and `info().run` carry `startedAt`. The `export` batch now has
  its label.

## [0.2.0] - 2026-09-25

### Fixed

- **Confirm saves at once during an analysis run.** `confirm`, `unconfirm` and
  the direct `proposalAccept`/`proposalReject` writes now apply immediately
  (200) even while a run holds the lock, instead of queuing (202) and leaving
  the row unconfirmed until the run ends; the agent's `apply` sees the row as
  confirmed and reopens it only on a real content change. Other direct writes
  stay queued. A queued write dropped at the end of a run now emits a
  `progress` event naming the row. The page no longer reloads after a 202
  (toast "queued") and keeps its scroll position on confirm/unconfirm.

### Changed

- **Accept/reject suggestions queue instead of applying instantly.** The
  suggestion chip's Accept/Reject buttons ("Accept all on this tab" too) no
  longer call `/api/proposal/:id/accept|reject` from the page: each queues a
  `decision` entry alongside notes (one per proposal; clicking the other
  action replaces it, clicking the same action again undoes it), shown as
  "✓ accept queued"/"✗ reject queued" with an undo (↺) on the chip itself and
  listed in the Queued panel ("Accept P-3 · GEN-04 · −2 PD"). `Send (n)`
  counts decisions with notes; the queue also sends itself once queued
  decisions exceed 15 (never while a run holds the lock — sent right after).
  `POST /api/batch {kind:'notes'}` applies every queued `decision` first,
  through the same `ops.accept`/`ops.reject` the direct endpoints use, as one
  write and one reload, before any remaining notes/chat reach the agent — a
  decisions-only batch never reaches the agent at all, and the reestimate/
  analyze it may unblock runs once instead of once per decision. The direct
  `/api/proposal/:id/accept|reject` endpoints are unchanged, for the CLI and
  agents.
- **No more table jump on accept/reject, or any other document refresh.**
  `renderDoc`/`renderArea` save `window.scrollY` and every `.grid-wrap`'s
  scroll position before a rebuild and restore them after, keyed to the
  active tab.
- **The Requirement cell shows up to 20 lines before clamping**, was 2; a
  "More"/"Less" link appears below it only when the text overflows that
  clamp, toggling the same expand/collapse the row click already used.

### Added

- **`unconfirm` — take back a confirmation.** `confirm|unconfirm <doc> <id>...`
  (CLI), `POST /api/unconfirm` (`{ids}`, queued under the lock like `confirm`),
  and a click on the confirmed row's tick (now a solid green button, tooltip
  "Confirmed — click to unconfirm", no dialog) all reverse a confirm: the item
  goes back to `reopened` — the same status any other reopen uses, so it
  counts as dirty/unconfirmed in readiness, the filters and the totals — and
  References gets `reopened <date>: unconfirmed by operator`. Refuses an id
  that isn't confirmed; Client Response, Assumptions, Effort and Internal note
  are untouched.

### Changed

- **Intake confirms itself — no extraction review step.** `intake` now sets
  `intake: confirmed` on its own and queues the first `analyze` chunk right
  away; there is no operator confirmation gate before analysis starts. Move,
  skip and restore work at any time through a queued row note, not only
  during review — skipping a confirmed item is refused with reason
  "unconfirm first". The page's Confirm extraction button and review-only
  gating are gone; the Overview banner now shows Not-taken rows and unused
  sheets whenever they exist, independent of intake state. `intake-confirm`
  stays only to confirm an old document still at `intake: review` (or reports
  "already confirmed"); opening a session on such a document confirms it and
  queues analyze itself, so no document is left stuck in review.
- **Automatic, progressive analysis — no Analyze button.** Confirming the
  extraction (the page's Confirm extraction, or the CLI's `intake-confirm`)
  now queues the first `analyze` chunk itself; the next chunk is queued as
  soon as the previous one finishes, until nothing is left, so the operator
  never has to click Analyze or run `batch --kind analyze` by hand (IN-3,
  IN-11). Each chunk assesses up to ~15 items in page order (§4's own tab/
  topic/client order) and its `items` list is now part of the batch payload
  (`/api/batch`, `/api/next`, `poll`'s output); the CLI/API still accepts an
  explicit `items` list or computes one when none is sent. Between chunks the
  document is unlocked, so an operator's Accept, Reject or Confirm click
  during a chunk lands before the next one is decided. The page's Analyze
  button is gone; a header pill shows "Analysing n of N" while a chain runs.
- **1-3 scope-locking proposals required for non-OOTB coverage (AQ-2).**
  `apply` now refuses a report item scored Configuration, Extension, ISV or
  Custom unless it carries 1-3 proposals, each with a numeric `pdSaved`
  greater than 0 and no greater than the item's own effort, or a `noProposal`
  reason — accepted only when the item's already-accepted assumptions already
  cover it; OOTB and `—` stay exempt.
- **Accepting a proposal lowers effort at once.** `accept` on a numeric-PD
  item now subtracts the proposal's `pdSaved` from its Effort immediately
  (floored at the profile's XS calibration point, or 0.25 with no profile),
  recording `was <old>` in References; a T-shirt size is left for the next
  re-estimate to refine. A global accept still only marks items for
  re-estimate.
- **§4 column order: client inputs, then working fields.** The scope-item
  header/columns become `ID · Prio · Requirement · Requirement Coverage ·
  Confidence · Estimation · Client Response · Assumptions · Internal note ·
  References · Status` — `Requirement` moves next to `Prio`, and `Effort` is
  relabelled `Estimation` everywhere user-facing (page grid, filter, the run
  report's `estimation_by_priority` line, the tool's own exported workbook).
  The report JSON key stays `effort`. `lib/parse.mjs` still reads a document
  written in the pre-rename header/order; every renderer always writes the
  new one, so an old document migrates on its next write.

### Changed

- **Working-document format.** `specs/rfp-NNNN-slug-analysis.md` moves to a new
  eight-section grammar (`Context, Totals, Global assumptions and exclusions,
  Scope items, Questions, Integrations, Glossary, Log`) with a fixed
  §4 scope-item header, six Requirement Coverage values (`OOTB · Configuration
  · Extension · ISV · Custom · —`), a two-regime Effort cell (T-shirt or
  partner-profile PD) and a `Status` cell (`queued · estimated ·
  blocked CQ-n · failed · confirmed YYYY-MM-DD · reopened`). Files written in
  the previous grammar are not read by this version.
- **Agentic extraction into the tool's own tabs, replacing the mapping
  wizard.** There is no more client-sheet mirror and no mapping screen: an
  agent (`sw-tender-editor`'s `extract` job) reads the import digest (xlsx/csv)
  or the source itself (PDF) and produces an extraction JSON, which
  `intake <doc> --source <file> --extraction <json>` turns into §4's three
  fixed tabs — `Functional`, `Non-functional`, `Project & services` — grouped
  by topic. The operator reviews that extraction once on the page (an
  `intake: review` frontmatter flag gates `analyze` until they run
  `intake-confirm <doc>`), moving an item to another tab/topic (`move`),
  skipping one with a reason (`skip`) or restoring it (`restore`); a `notes`
  batch queued during review re-runs the extraction instead. §1 gains a
  **Project information** table (18 fixed rows, e.g. business model, markets,
  Shopware version) — its Values are the client's or operator's own facts,
  kept verbatim, amounts included; no money check applies to them anywhere
  (intake, `info`, `check`, export) — and a **Not taken from the source**
  table for skipped rows. A platform/hosting/PSP/CMP recommendation lives in
  its scope item's Client Response, and the Shopware target lives in Project
  information. For an xlsx source, `intake` writes a committed fit-back map
  (`<srcdir>/<base>/import-map.json`, replacing the gitignored `rows.json`)
  that `export` uses to write each confirmed item back into the client's own
  sheet and row; a CSV or PDF source still gets its own built workbook.
  `import --map`/`--accept-proposed`, the per-table CSVs and the
  `/api/import/map`/`/api/import/confirm` routes are gone.
- **Requirement Coverage → client token (RC-4) moves from intake to export.**
  A new `tokens <doc> --suggest | --file <json>` command decides the
  six-value map per requirements table agentically, right before `export` —
  `--suggest` prints each table's recorded tokens/legend plus
  `import-map.mjs`'s existing heuristic guess (`guessCoverageTokenMap`,
  unchanged, no longer written into the map at propose time),
  `--file` validates (all six keys, each value one of the table's own
  tokens/legend or free text when it has no token list, never a
  negative-reading token for a value the partner delivers) and writes
  `tokens.coverage` into the confirmed import map. `export`'s surgical xlsx
  path now refuses, listing the tables, until every requirements table with
  a compliance column has a full six-value map; `POST /api/export` queues a
  batch kind **`export`** (also addable via `batch --kind export`) and
  returns 202 `{queued}` instead, when an agent is present. The export
  preview shows the raw Requirement Coverage value, labelled "(client token
  set at export)", until it is mapped. CSV/PDF sources are unchanged — they
  never needed a client token map.
- **Numbered exports.** Every export writes a fresh `<base>-response-v<n>.xlsx`,
  `n` the next free version; an existing file is never overwritten, and an
  explicit `--out` that already exists is refused. Each run appends a §8 Log
  line (`export v<n> · <file> · confirmed <c>/<n> · changed since v<n-1>:
  <k>`) and prints the version and what changed since the last export — the
  items whose export text differs from the previous version's snapshot
  (`specs/.rfp/<slug>/exports.json`), or that are newly confirmed. The same
  set is carried in `GET /api/session`'s `sinceExport`, and the page offers a
  "changed since last export" filter.
- **`cost:` signal.** A scope item's References may carry one `cost:` line —
  set by the architect when a coverage choice carries a cost consequence (a
  licence, a subscription, a paid ISV, a hosting tier) — with no amount (the
  amount check still applies to it; money words do not). It shows as a "cost"
  badge on the item, with the line as its tooltip; it is never exported and
  never reopens the item.
- The page's separate **Notes** panel is gone. **Queued (n)** replaces it — a
  collapsible accordion inside the single **Agent** card (ported from
  sw-specs-editor's 0.1.2), forced open when Annotate mode adds an entry. Each
  row shows a missing-block warning, the clickable block reference or the
  entry's kind for a chat-only entry, the text and a ✕ to drop it; **Clear**
  empties the queue. **Send (n)** ships the queue with whatever is in the chat
  box — chat text alone also sends. The `+ free note` button is gone.
- **The agent panel folds.** The `>` button in the panel head collapses it to
  a slim right-edge rail with a `<` button, a queued-count badge and a
  working dot; `<` reopens it. State persists in `localStorage`
  (`tender-tool:panel`), default open; `]` toggles it from the keyboard. A
  folded panel never reopens itself — the rail is the only signal while a
  reply or progress line arrives.
- Batch kinds are `intake`, `analyze`, `reestimate`, `notes` and `export`
  (the previous `batch`, `reconcile` kinds are gone). Confirming a scope
  item, accepting or rejecting a proposed assumption, answering a client
  question, editing the Client Response or Internal note, writing the
  partner profile and setting a Project information value are runtime
  actions the page and the command line both call directly — none of them
  spawns an agent.
- `status`'s `notes_unsent` field is `queued_unsent` (0.2.0 is unreleased, so
  this is a straight rename, no alias).
- The CSV/PDF export workbook mirrors the working sheet's own tabs in page
  order — `Overview` (regime, totals by priority and by tab, readiness
  counts), `Project information`, the three scope tabs, `Integrations`,
  `Glossary` — instead of a separate `Totals` tab; `Log` and References stay
  unexported. `analyze` is accepted once `intake: confirmed` whenever there
  is queued/reopened or re-estimate work; `force` is only needed for the
  no-work case.
- The chat no longer repeats the session banner of every past run. Older
  `session started/resumed/closed` lines collapse into a single muted
  **previous session** divider at each boundary; only the current session's
  line is shown. The conversation itself still loads in full, and `chat.jsonl`
  keeps every line for the agent's context.
- **Intake starts automatically on open.** `start` on a source with no working
  document yet queues the opening `intake` batch itself, the moment the
  import (or, for a PDF, nothing) has had its chance to run — a reattach or a
  restart never queues a second one, and once an analysis exists nothing is
  queued. `--no-intake` opts out; the page's "Start intake" button stays as
  the fallback either way. While the batch is queued or running, the "No
  working document yet" card replaces the button with a spinner, the run's
  stage and its latest progress line instead.
- **Heartbeat timeout no longer ends the session immediately.** The page going
  quiet (closed tab, reload, laptop sleep) now opens a 10-minute close grace
  (`TENDER_TOOL_CLOSE_GRACE_MS` to override) before the server actually
  shuts down; a heartbeat within the grace resumes the same session, same
  port, lock, queue and chat. `poll` keeps returning `idle` through the
  grace and only reports `closed` once it elapses. An explicit `/api/close`
  (Stop button, `stop`) is unaffected and still closes immediately.

### Fixed

- The run report's warnings never showed: the chat bubble read `e.warnings`,
  but a reply's warnings are posted as `repairs`.

### Added

- `intake`, `apply`, `check`, `report`, `confirm`, `accept`, `reject`,
  `assume`, `unassume`, `answer`, `patch` and `profile` commands. `check
  --write` regenerates §2's totals; `report` prints the run report (state,
  confirmed of total, failed, open client questions, not decomposed, low
  confidence, effort by priority with its regime, waiting proposals, what
  changed) and writes `specs/.rfp/<slug>/last-run.json`.
- `specs/.rfp/<slug>/proposals.json` and `reestimate.json` — the assumption
  and re-estimate memory a run reads and writes; never in the working
  document or an export. `specs/rfp-partner-profile.md` — the gitignored
  partner profile that switches the estimation regime from T-shirt to
  person-days.
- `sw-tender-discovery-tool uninstall-skill [--target <dir>] [--root <path>]` —
  removes the one `SKILL.md` `install-skill` wrote, and the
  `sw-tender-discovery-tool/` directory once it is empty. A copy the host has
  edited is kept and reported, never deleted; an absent file is
  `changed: false`, not an error. The two commands resolve their target
  identically, so they are exact opposites.
- The partner profile wizard's two calibration inputs are grouped under an
  "Estimation calibration" heading with an XS anchoring example for the small
  change and an XL one for the big change, so operators enter the same kind
  of figure; "Reusable assets" gets an example list too.

## [0.1.1] - 2026-09-19

### Fixed

- A filesystem watch error (for example `EMFILE` under file-descriptor
  pressure) no longer crashes the server process: the dead watcher is dropped,
  the page is told that edits made outside it are not picked up, and the watch
  is retried three times with a short backoff before it gives up.

### Added

- First packaged release. Previously an internal tool inside a Shopware
  agentic harness; now a standalone repository and npm package.
- `skills/sw-tender-discovery-tool/SKILL.md` — the stub skill, shipped in the
  package and installed into a host by
  `sw-tender-discovery-tool install-skill`. The tender *method* stays in the
  harness's own `sw-discover-tender` skill; this one only drives the page.
- `lib/paths.mjs` — project-root resolution by walk-up from the document, so the
  CLI no longer depends on the caller's working directory.
- MIT `LICENSE`, `THIRD-PARTY-NOTICES.md`, consumer `README.md`.
- Tag-driven release: pushing `v<version>` publishes to npm from GitHub Actions
  with `--provenance`, authenticated by OIDC trusted publishing. No npm token
  is stored in this repository.
- `scripts/check-version.mjs` — refuses a release whose shipped skill pins a
  different CLI version than `package.json` declares.
- `test/conformance.test.mjs` — the shared editor-CLI contract, vendored
  byte-for-byte from the sibling package apart from its command list.

### Fixed

- `poll` printed `batch_file` as a project-relative path. The agent resolves it
  against *its own* working directory, which need not be the one the CLI ran in,
  so a batch polled from a subdirectory named a file that was not there. It is
  now absolute, with `batch_file_rel` alongside it for logs; the batch payload
  gained `root`, `fileAbs`, `contextAbs`, `analysisAbs` and `sourceAbs` twins.
  The relative fields the page reads are unchanged.
- `start` now refuses a document outside the project root with a usage error
  instead of opening a session whose state lands where nothing will look for it.

[Unreleased]: https://github.com/execuro/sw-tender-discovery-tool/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/execuro/sw-tender-discovery-tool/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/execuro/sw-tender-discovery-tool/compare/v0.1.0...v0.1.1
