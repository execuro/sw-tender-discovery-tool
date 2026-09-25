# Tender Discovery Tool

Local, zero-dependency runtime that renders a tender analysis sidecar (`specs/rfp-NNNN-slug-analysis.md`, written by `sw-discover-tender`) as one live page. The operator confirms scope items, answers client questions, edits the Client Response and Internal note in place, and runs the partner-profile wizard; the runtime applies every one of those directly. Accepting or rejecting a proposed assumption instead queues a decision alongside notes, applied in one batch (with the queue's own auto-send once decisions pile up) rather than one call per click. Only a batch (`intake`, `analyze`, `reestimate`, `notes`, `export`) spawns an agent. Annotations, chat and decisions collect in the Agent card's collapsible **Queued (n)** block; the agent panel itself folds to a slim rail so the working sheets get more room. Spawned by `sw-discover-tender … --editor`.

Requires Node ≥ 20.15 (`zlib.crc32`, used when writing the response workbook). Nothing to install, no dependencies.

Published as `@execuro-sw-ecosystem/sw-tender-discovery-tool`. The skills that
drive this tool run `npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@latest`;
a pinned version, e.g. `npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.2.0
start --doc <path>`, is how a consumer reproduces one exact release. Every
command below is shown as `sw-tender-discovery-tool <subcommand>` — that is
the bin name and the exact suffix to append after the `npx …` prefix above.
The bare form on its own only runs directly against a local development
checkout (`npm link`, or `node bin/cli.mjs <subcommand>`).

## Layout

| Path | Role |
| --- | --- |
| `lib/server.mjs` | http server on `127.0.0.1` (random port, `TENDER_TOOL_PORT` to pin): page, JSON API, SSE, file watcher, batch queue, one lock per run, queued direct writes, snapshot + repair, heartbeat timeout with a 10-minute close grace (`TENDER_TOOL_CLOSE_GRACE_MS` to override) so a reconnect resumes the same session, session persistence |
| `lib/yaml.mjs` | minimal YAML reader for the frontmatter |
| `lib/parse.mjs` | markdown → block model: `TABS`, `PROJECT_INFO`, `SECTION_TITLES` (the 8 sections), `splitHeading`, `renderProjectInfo`/`renderNotTaken`, `sheetPrefix`/`generateIds` (SI-2 ids), the item/question/assumption block model with stable ids |
| `lib/edit.mjs` | single-line primitives `tick`, `answer`, `propose`; `snapshot` + `verifyAndRepair` around an agent run |
| `lib/calc.mjs` | pure projection: PD per row, `totals()` (`byPriority`, `byTab`, `total`), readiness; also served to the page at `/page/lib/calc.mjs` |
| `lib/diff.mjs` | old vs new model → changed / added / removed ids |
| `lib/xlsx.mjs` | zero-dependency xlsx reader: zip (incl. zip64, stored and deflate) + SpreadsheetML, shared **and** inline strings, cached formula values, 1900/1904 dates, hidden sheets/rows/columns, merges and the data-validation dropdown lists that carry the client's allowed tokens. Refuses `.xls`/`.xlsb`/encrypted workbooks with one line saying what to do |
| `lib/xlsx-patch.mjs` | writes answers back into a **copy**: every zip entry we do not touch keeps its original compressed bytes, so styles, themes and dropdowns are bit-for-bit the client's own; an overwritten formula cell drops its `<f>` and its calcChain entry |
| `lib/xlsx-build.mjs` | builds a fresh, minimal working-sheet workbook for a CSV or PDF source, mirroring the working sheet's own tabs in page order: `Overview` (regime, totals by priority and by tab, readiness counts), `Project information`, one tab per `TABS` entry that has items (always present), `Integrations`, `Glossary`; `Log` and References are never exported |
| `lib/import-map.mjs` | `proposeMap`: a first guess at each visible sheet's table shape and answer columns, feeding the import digest's `Proposed:` line only — the extraction job decides the real mapping; also the CSV reader, the coverage-token heuristic (`guessCoverageTokenMap`) and `readFitBack` |
| `lib/digest.mjs` | renders `import-digest.md`: every visible sheet, in workbook order, with `proposeMap`'s own guess and every non-empty row — the one file the extraction job reads |
| `lib/import-export.mjs` | `import` (reads the source, writes the snapshot, proposed map and digest) and `export` (fits confirmed items back into a copy of an xlsx source via the fit-back map, or builds the tool's own workbook for a csv/pdf source) |
| `lib/intake.mjs` | `intake`: validates the extraction JSON, builds/merges §4 into the three fixed tabs by topic, fills §1 Project information and Not taken, writes the xlsx fit-back map, confirms itself (`intake: confirmed`); also `restoreFromSource` for `ops.mjs`'s `restore` |
| `lib/ops.mjs` | operator operations: `confirm`/`unconfirm` (unconfirm reopens the item — same `reopened` status as any other reopen, References gets `reopened <date>: unconfirmed by operator` — Client Response, Assumptions, Effort and Internal note untouched), `accept`/`reject` a proposal (accepting lowers a numeric PD Effort by the proposal's `pdSaved` at once, floored, recording `was <old>`; a later re-estimate refines it), `assume`/`unassume`, `answer`, `patch`, `profile`, `tokens{Suggest,Apply}`, and `move`, `skip`, `restore`, `info` — all available at any time; `skip` on a confirmed item is refused; `intakeConfirm` stays for a document still at `intake: review` (old ones only) |
| `lib/apply.mjs` | apply an architect's report JSON to §4: formats Estimation per regime, stores proposals and client questions, reopens a confirmed item whose Coverage, Estimation or Client Response actually changed; refuses a non-OOTB item with neither 1-3 proposals (each with a numeric `pdSaved` > 0, no greater than the item's own effort) nor a `noProposal` reason valid only when the item's already-accepted assumptions already cover it (AQ-2) |
| `lib/check.mjs` / `lib/report.mjs` | `check [--write]` validates grammar, the six Requirement Coverage values, reference prefixes, the money scan (incl. §1 Project information) and §2's totals, and (with `--write`) regenerates §2; `report` prints the run report and writes `last-run.json` |
| `lib/export-text.mjs` | the exact text `export` writes for one scope item, used by the `export-text` command/endpoint and the `export` batch's token-mapping step |
| `lib/profile.mjs` | the partner profile (`specs/rfp-partner-profile.md`) and the T-shirt/profile regime |
| `lib/proposals.mjs` | proposal memory (`specs/.rfp/<slug>/proposals.json`) and the re-estimate queue (`reestimate.json`) |
| `lib/session.mjs` / `lib/paths.mjs` | finding the running session from a document; project-root and path resolution shared with sw-specs-editor's contract |
| `lib/out.mjs` | the shared output contract: `key: value` lines, `next_step:`, exit codes |
| `page/` | `index.html`, `app.js`, `app.css`, `view.mjs` (pure, DOM-free view logic, unit-tested), `vendor/marked.min.js` — vanilla JS, no build |
| `bin/cli.mjs` | the one executable — see [Commands](#commands) for the full tree. Every other file exports `main(argv)` and never reads `process.argv`, so the commands work through an npx `.bin` symlink; a command whose module has not landed yet fails alone, with exit 1 |
| `lib/emit.mjs` | `emit progress\|chat\|done "<text>" [--batch id]` — the subagent's only channel to the page |
| `test/` | `node --test test/*.test.mjs` — one suite per `lib/` module, plus `cli`, `cli-import`, `server`, `server-import`, `e2e-cli`, `install-skill`, `uninstall-skill`, `paths`, `page-view`, `page-dom`, `conformance` — and the two release gates `check-pack` and `check-version`. The server suite needs permission to bind `127.0.0.1` |

## Tabs

The page's tabs are fixed and always present, in this order (an empty scope tab shows "No items"):

| Tab | Shows |
| --- | --- |
| Overview | §2 totals, confidence, the export gate, every question no requirement row owns; a Not-taken banner shows whenever there are Not-taken rows or unused sheets — item counts per tab, the rows (each with a Restore button), unused sheets, answer targets per client table; intake confirms itself and starts the analysis automatically, in small chunks (IN-3/IN-11) — a header pill shows "Analysing n of N" while a chain is in flight |
| Project information | the 18 fixed `PROJECT_INFO` rows, Value editable in place, Source shown; a value is the client's or operator's own fact, kept verbatim including any amount — the tool's money check never applies here |
| Functional / Non-functional / Project & services | the §4 scope items of that tab, topics as sub-headings in first-seen order, each row a spreadsheet-style grid line: Client Response and Internal note are live textareas, every other column read-only; a sticky tick left of the id confirms the item; once confirmed it becomes a solid green button — click it again to unconfirm (no dialog, cheap to redo); moving it to another tab or skipping it, at any time, is a queued note ("move to <tab>" / "skip: <why>") the agent turns into `move`/`skip` — skip on a confirmed item is refused ("unconfirm first"); an item whose References carry a `cost:` line (a licence, a subscription, a paid ISV, a hosting tier — set by the architect, no amount, one per item, never reopens it, never exported) shows a "cost" badge with the line as its tooltip |
| Integrations | §6 |
| Glossary | §7, whose terms are also marked in the requirement text |
| Log | §8 |

Panels are rendered once and toggled, never re-rendered, so a patch that lands on a row in a hidden tab is never lost.

## Commands

The session:

```
sw-tender-discovery-tool guide                                      # the session protocol - the single source, read it first
sw-tender-discovery-tool start  --doc specs/rfp-0001-x-analysis.md  # prints TENDER_TOOL_URL=…, detaches; reattaches if running
sw-tender-discovery-tool start  --doc specs/rfp-0001-x.xlsx         # source path accepted; analysis may not exist yet - queues the opening intake batch itself, once
sw-tender-discovery-tool start  --doc specs/rfp-0001-x.xlsx --no-intake   # opt out; the page's "Start intake" button is then the only way to start it
sw-tender-discovery-tool status --doc specs/rfp-0001-x-analysis.md  # live summary of GET /api/session; --json for the full payload
sw-tender-discovery-tool poll   --doc specs/rfp-0001-x-analysis.md  # waits up to 90 s -> batch | idle | closed
sw-tender-discovery-tool batch  --kind intake|analyze|reestimate|notes|export
sw-tender-discovery-tool stop   --doc specs/rfp-0001-x-analysis.md
sw-tender-discovery-tool install-skill                               # write skills/<host>/sw-tender-discovery-tool/SKILL.md; --target <dir>, --print, --force
sw-tender-discovery-tool uninstall-skill                             # remove it again; a copy you edited is kept, not deleted
sw-tender-discovery-tool start --doc … --foreground --grace 60 --agent-timeout 180 --idle 14400
```

The client's workbook, in and out. An agent extracts requirements into the tool's own tabs — there
is no mapping screen and no per-table CSVs:

```
sw-tender-discovery-tool import --source specs/rfp-0001-x.xlsx        # read the workbook, write the import digest (xlsx/csv only)
# … run the sw-tender-editor extract job over the digest (or, for a pdf, straight over the source) …
sw-tender-discovery-tool intake specs/rfp-0001-x-analysis.md --source specs/rfp-0001-x.xlsx --extraction extraction.json
  # builds/merges §4 into Functional/Non-functional/Project & services, fills §1 Project information
  # and Not taken, confirms itself (intake: confirmed) and auto-queues the first analyze chunk (IN-3);
  # for an xlsx source also writes the committed fit-back map
sw-tender-discovery-tool intake-confirm specs/rfp-0001-x-analysis.md                              # only for a document still at intake: review (an old one); "already confirmed" otherwise
sw-tender-discovery-tool move    specs/rfp-0001-x-analysis.md <id> <tab> [--topic "<t>"]           # any time; never reopens, never changes the id
sw-tender-discovery-tool skip    specs/rfp-0001-x-analysis.md <id> "<why>"                          # any time; refused with "unconfirm first" on a confirmed item
sw-tender-discovery-tool restore specs/rfp-0001-x-analysis.md "<source>"                            # any time; source is a Not-taken row's own pointer
sw-tender-discovery-tool info    specs/rfp-0001-x-analysis.md <key> "<value>"                       # set one Project information Value, Source becomes operator
sw-tender-discovery-tool export  specs/rfp-0001-x-analysis.md [--out <file.xlsx>]                   # anytime; unconfirmed items export empty answer cells; --out must end in .xlsx and never the source or the working document
```

Every export writes a fresh `<base>-response-v<n>.xlsx`, `n` the next free version; an existing
file is never overwritten, and an explicit `--out` that already exists is refused. Each run prints
`version` and `changed_since_last` (the items whose export text differs from the previous version,
or that are newly confirmed) and appends one §8 Log line (`export v<n> · <file> · confirmed
<c>/<n> · changed since v<n-1>: <k>`). `GET /api/session`'s `sinceExport` carries the same ids
(`null` before the first export), and the page offers a "changed since last export" filter.

For an xlsx source, a requirements table with a compliance column needs its Requirement Coverage → client-token map before `export` writes real client tokens (RC-4, decided agentically at export time, not at intake):

```
sw-tender-discovery-tool tokens specs/rfp-0001-x-analysis.md --suggest          # per table: recorded tokens/legend + a heuristic guess
sw-tender-discovery-tool tokens specs/rfp-0001-x-analysis.md --file tokens.json # { "<table key>": { OOTB, Configuration, Extension, ISV, Custom, "—" } }
```

Assessing an item — an agent's report is applied, never hand-written:

```
sw-tender-discovery-tool apply specs/rfp-0001-x-analysis.md --report report.json
```

The operator's own actions — every one of these is also what the page calls, so the same command line works with no page open at all:

```
sw-tender-discovery-tool confirm   specs/rfp-0001-x-analysis.md <id>...  | --all-unconfirmed
sw-tender-discovery-tool unconfirm specs/rfp-0001-x-analysis.md <id>...                          # confirmed only; reopens the item, References gets "reopened <date>: unconfirmed by operator"
sw-tender-discovery-tool accept   specs/rfp-0001-x-analysis.md <P-n>
sw-tender-discovery-tool reject   specs/rfp-0001-x-analysis.md <P-n>
sw-tender-discovery-tool assume   specs/rfp-0001-x-analysis.md <item|global> "<statement>"
sw-tender-discovery-tool unassume specs/rfp-0001-x-analysis.md <item|global> "<statement>"
sw-tender-discovery-tool answer   specs/rfp-0001-x-analysis.md <CQ-n> <key>
sw-tender-discovery-tool patch    specs/rfp-0001-x-analysis.md <id> [--response "<t>"] [--note "<t>"]
sw-tender-discovery-tool profile  specs/rfp-0001-x-analysis.md --file profile.json
```

Every run's tail — always the same two commands, whatever the batch did:

```
sw-tender-discovery-tool check  specs/rfp-0001-x-analysis.md --write   # grammar, the six values, ref prefixes, money scan, §2 totals; regenerates §2
sw-tender-discovery-tool report specs/rfp-0001-x-analysis.md           # the run report; writes last-run.json
```

Every command finds its session from the document, so none of them takes a URL.
Output is `key: value` lines, then `next_step:`, then any large payload last.
Exit codes: 0 success, 1 server unreachable / runtime failure, 2 usage error.
A command whose module is missing fails alone, with exit 1 and a "not available
yet" message — every other command works.

`<slug>` is the file name without `-analysis.md` or the source extension; it must start with `rfp-NNNN-`. Start needs the analysis or the source to exist.

## Session folder `specs/.editor/<slug>/` (gitignored)

`session.json`, `session.lock` (pid + url while running), `chat.jsonl`, `notes.json` (the Agent card's queued annotations and/or chat, not yet sent), `batches/<id>.json`, `import-snapshot.json` and `import-map.proposed.json` (the workbook as `import` read it, and `proposeMap`'s own guess — a starting point for the extraction job, never confirmed here), `import-digest.md` (the one file the extraction job reads), `snapshot.json` (frontmatter, hashes, frozen cells, ticks, answers, page-proposed lines at run start), `queue.json` (the durable batch queue: order + the batch in flight), `queued.json` (direct writes waiting for unlock), `proposed.json` (ids of `[ ]` lines the page inserted), `server.log`.

## Side files `specs/.rfp/<slug>/` (gitignored)

`extraction.json` — the last extraction `intake` used for this document, so a later `restore` can rebuild an item from it. `item-pointers.json` — `{ [id]: "<sheet> r<row>" | "PDF #<n>" }`, every current item's own source pointer, so `skip` can put it in a Not-taken row without re-deriving it. `proposals.json` — every assumption an agent proposed: `{ id, item, statement, pdSaved, status: waiting|accepted|rejected, run }`; a rejected statement is never proposed again. `reestimate.json` — items a `reestimate` batch still owes: `{ item, cause, at }[]` (`item: "*"` = all), cleared by `apply` for the items it writes. `last-run.json` — the previous run's item snapshot, read by `report` to say what changed. `exports.json` — `[{version, file, at, items}]`, one entry per export this tool has written for this document; `items` snapshots each confirmed item's export text at that version, the baseline the next export diffs against for `changedSinceLast`/`sinceExport` (an older, plain-string entry is still read, just with no snapshot). None of this is in the working document or any export; `specs/rfp-partner-profile.md`, next to the analysis, is the partner profile and is gitignored on its own.

The fit-back map `<source dir>/<basename>/import-map.json` (an xlsx source only) IS committed: it is what `export` uses to write each confirmed item back into the client's own sheet and row. It carries `source`, `sha256`, `extractedAt`, `confirmedAt`, one `tables[]` entry per client table (keyed `<sheet> r<headerRow>`, with its columns and coverage tokens), `unusedSheets` and `items[id] → {table, sheet, row}`. An item with no pointer in it is reported by `export` as `not written: <id> (no source row)`, never silently dropped. There are no per-table CSVs and no `rows.json` any more.

## API (all JSON, localhost only)

The page calls the same actions as the [Commands](#commands) section, one field at a time: `POST /api/confirm`, `POST /api/unconfirm`, `POST /api/intake/confirm`, `POST /api/intake/restore`, `PATCH /api/project-info/<key>`, `PATCH /api/item/<id>`, `POST /api/item/<id>/assumption[/remove]`, `POST /api/question/<cq>/answer`, `GET`/`PUT /api/profile`, `POST /api/export`, and `POST /api/batch` with `kind: intake|analyze|reestimate|notes|export`. `POST /api/proposal/<id>/accept|reject` stays for the CLI and agents; the page instead queues a `decision` entry in the `notes` batch (see below). `POST /api/item/<id>/move`, `POST /api/item/<id>/skip` and `GET /api/item/<id>/export-text` stay for the `notes` batch and the export flow, not for a page click — moving or skipping a row is a queued note, available at any time (skip on a confirmed item refused), and the exact export text is a CLI/API call, not a page preview.

| Method & path | Purpose |
| --- | --- |
| `GET /`, `GET /page/*`, `GET /page/lib/calc.mjs` | page, assets, the shared calc module (also served straight from `lib/` so the page and the CLI import one file) |
| `GET /api/session` | `{session, analysis, source, model, parseError, notes, chat, queued, intake, fitBack, proposals, sinceExport}`; `model` is the `lib/parse.mjs` output, `null` until the analysis exists; `parseError` is `{message, at}` while the file on disk fails to parse (the last good `model` stays live); `intake` is `{state: review\|confirmed, notTaken: n, unusedSheets: [names]}`; `fitBack` is the committed fit-back map, or `null` for a csv/pdf source; `sinceExport` is the ids
changed since the last export (`null` before the first one); `session` is `Session#info()` — `{slug, dir, port, url, started, resumed, batches, lastBatch, agent, lock, run, queue, grace, queuedWrites, analysis, source, exists, parseError, doc:{state, rows, pending:{openCQ, waitingProposals}, regime}}` |
| `GET /api/events` | SSE: `hello`, `doc` (model, changed/added/removed ids, reason, parseError), `chat`, `progress`, `run`, `agent`, `notes`, `import`, `closing`; keepalive 15 s |
| `POST /api/heartbeat` | `{tab}` → `{ok, agent, run, lock}`; 60 s without any → server exits |
| `POST /api/notes` | autosave the Agent card's queued annotations/chat before they are sent |
| `POST /api/batch` | `{kind: intake\|analyze\|reestimate\|notes\|export, notes?, chat?, stage?, force?, items?}` → `{id, file, queued, items?}`; a `notes` batch needs at least one queued entry or non-empty chat, else 400; `analyze` while `intake: review` (a legacy document not yet confirmed), or (once confirmed) `analyze` with no queued/reopened work and no `force` → 400 `{error, reason}`; an `analyze` batch's `items` (an explicit list, or computed: up to ~15 ids still needing work, in page order, IN-11) is also queued automatically once intake confirms itself and after each chunk finishes — the page has no button for it any more (§5). A `notes` batch's `type: 'decision'` entries (`{proposal, item, action: accept\|reject}`, the page's queued suggestion decisions) are applied first, as one write through `ops.accept`/`ops.reject` and one reload, before the remaining notes/chat reach the agent; a batch that is decisions only never reaches the agent — `{id: null, decisionsApplied}` instead |
| `POST /api/run/abort`, `POST /api/close`, `GET /api/lock` | abort the active run (unlock, apply queued), end the session, lock + agent + queue |
| `POST /api/confirm` | `{ids}` → 200 `{ok, confirmed, skipped, rejected}` (also during a run); bulk confirm is partial-success — `skipped` is `[{id, reason}]` for every id it could not confirm, the rest still confirm; `rejected` is `[{id, item, statement}]`, the still-waiting proposals confirming auto-rejected |
| `POST /api/unconfirm` | `{ids}` → 200 `{ok, unconfirmed, skipped}` (also during a run); refuses an id that is not confirmed (`skipped: [{id, reason}]`), the rest still unconfirm; reopens the item (same `reopened` status as any other reopen) |
| `POST /api/intake/confirm` | only for a document still at `intake: review` (an old one): sets `intake: confirmed` (and `confirmedAt` on the fit-back map) and queues analyze → 200 / 202; otherwise reports already confirmed |
| `POST /api/item/<id>/move` | `{tab, topic?}` → moves the item to `<tab> · <topic>`; allowed at any time → 200 / 202 / 400 (no tab) |
| `POST /api/item/<id>/skip` | `{why}` → removes the item from §4 and adds a Not-taken row; allowed at any time, refused with reason "unconfirm first" on a confirmed item → 200 / 202 / 400 |
| `POST /api/intake/restore` | `{source}` → rebuilds the item the Not-taken row's `source` pointer names; allowed at any time → 200 / 202 / 400 |
| `PATCH /api/project-info/<key>` | `{value}` → sets one Project information Value, Source becomes `operator` → 200 / 202 / 400 |
| `POST /api/proposal/<id>/accept\|reject` | decide a proposal → 200 / 202 / 404 (no such proposal) |
| `GET /api/proposals` | `{proposals}` — the full `proposals.json`, `[]` before the analysis exists |
| `PATCH /api/item/<id>` | `{clientResponse?, internalNote?}`, one field at a time → 200 / 202 / 404; any other field (e.g. `coverage`, which only `apply` may set) → 400 `{error, reason}` |
| `GET /api/item/<id>/export-text` | `lib/export-text.mjs`'s `{token, response, effort, assumptions, tokenPending}` for that item, using the fit-back map's tokens; `tokenPending` marks a raw coverage value shown before `tokens --file` has mapped it (an xlsx table with a compliance column but no coverage map yet); visible for every item, confirmed or not |
| `POST /api/item/<id>/assumption` / `/assumption/remove` | `{statement}` → add or remove an assumption on that item → 200 / 202 / 400 (no statement); `<id>` of literally `global` addresses the operator-typed global assumptions in §3 instead of a scope item |
| `POST /api/question/<cq>/answer` | `{option}` → record the client's or operator's answer → 200 / 202 / 400 (no option) |
| `GET`/`PUT /api/profile` | read / write `specs/rfp-partner-profile.md`; a `PUT` marks every item for re-estimate |
| `POST /api/export` | `{out?}` → `{ok, file, version, changedSinceLast, notWritten}`: surgical xlsx copy (via the fit-back map) or built working-sheet workbook, per source kind, always a fresh `-response-v<n>.xlsx`, never overwriting an existing file; 202 `{queued, batch, tables}` when an xlsx table's coverage tokens are not mapped yet and an agent is present (queues an `export` batch instead); 400 on a write failure (including the same coverage-tokens refusal, when no agent is present, or no fit-back map for an xlsx source) |
| `GET /api/next?wait=<s>` | **agent** long-poll → `{event:"batch", batch, batch_file, ...}` / `{event:"idle"}` / `{event:"closed"}`; reserves the batch, locks and snapshots. The reservation is only final once the agent acknowledges it through one of the `/api/agent/*` endpoints: a poll that dies before the response is written rolls it back, and an unacknowledged run is re-delivered to the next poll, so a killed `poll` never loses a batch |
| `GET /health` | package name and version, pid, slug, url, start time. `start` probes it: a matching version reattaches, a different one is stopped and restarted |
| `POST /api/agent/progress` / `chat` / `reply` | **agent** progress line, interim message, final reply (verify + repair, diff vs snapshot, reload, unlock, apply queued) |

## Direct writes

Every write re-reads the file from disk, changes one line through `lib/edit.mjs`, writes atomically (`.tmp` + rename; the watcher ignores `.tmp`) and pushes a `doc` event. Confirm, unconfirm and proposal accept/reject apply immediately even while a run holds the lock. Any other write made while a run holds the lock is appended to `queued.json` (202) and everything queued is applied in order, one by one, after the reply or abort; a write the file no longer accepts is dropped with a `system` chat line and a `progress` event naming the row. A frozen line (`accepted` / `rejected`) is never changed by the page.

## Agent channel

The skill loop calls `GET /api/next` and spawns one subagent per batch file (`{id, kind, sentAt, session, analysis, source, slug, notes, chat, pending:{ticks, answers, proposals}, context, file}`). The subagent edits the analysis directly and reports through `bin/cli.mjs emit`; `done` triggers the repair pass (frontmatter, frozen cells, human ticks, page-proposed lines) and releases the lock. Presence flips (`agent` events, `--agent-timeout`) never abort a run; only `POST /api/run/abort`, an `abort` reply or Stop does.
