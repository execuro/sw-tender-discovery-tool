# Tender Discovery Tool

Local, zero-dependency runtime that renders a tender analysis sidecar (`specs/rfp-NNNN-slug-analysis.md`, written by `sw-discover-tender`) as one live page. The user ticks assumptions, answers open questions, proposes assumptions, annotates any text and chats with the agents; the page shows the projected effect of unreconciled ticks. Only the skill reconciles: the page writes ticks, answers and proposed `[ ]` lines, nothing else. Spawned by `sw-discover-tender … --editor`.

Requires Node ≥ 20.15 (`zlib.crc32`, used when writing the response workbook). Nothing to install, no dependencies.

Published as `@execuro-sw-ecosystem/sw-tender-discovery-tool`; the canonical
invocation is a pinned `npx`, e.g.
`npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.1.1 start --doc <path>`.
Every command below is shown as `sw-tender-discovery-tool <subcommand>` — that
is the bin name and the exact suffix to append after the `npx …@0.1.0` prefix
above. The bare form on its own only runs directly against a local
development checkout (`npm link`, or `node bin/cli.mjs <subcommand>`).

## Layout

| Path | Role |
| --- | --- |
| `lib/server.mjs` | http server on `127.0.0.1` (random port, `TENDER_TOOL_PORT` to pin): page, JSON API, SSE, file watcher, batch queue, one lock per run, queued direct writes, snapshot + repair, heartbeat timeout, session persistence |
| `lib/yaml.mjs` | minimal YAML reader for the frontmatter |
| `lib/parse.mjs` | markdown → block model with stable ids (`STF-01`, `STF-01.a2`, `A-1`, `CQ-1`, `s2.p3`, `t4.r2`), typed tables, question blocks, `deriveMeta` |
| `lib/edit.mjs` | single-line primitives `tick`, `answer`, `propose`; `snapshot` + `verifyAndRepair` around an agent run |
| `lib/calc.mjs` | pure projection: PD per row, totals, delta vs §2, impact per line; plus the page's tab model (`pageTabs`, `tabOfRow`, `tabOfSection`, `glossary`); also served to the page at `/page/lib/calc.mjs` |
| `lib/diff.mjs` | old vs new model → changed / added / removed ids |
| `lib/xlsx.mjs` | zero-dependency xlsx reader: zip (incl. zip64, stored and deflate) + SpreadsheetML, shared **and** inline strings, cached formula values, 1900/1904 dates, hidden sheets/rows/columns, merges and the data-validation dropdown lists that carry the client's allowed tokens. Refuses `.xls`/`.xlsb`/encrypted workbooks with one line saying what to do |
| `lib/xlsx-patch.mjs` | writes answers back into a **copy**: every zip entry we do not touch keeps its original compressed bytes, so styles, themes and dropdowns are bit-for-bit the client's own; an overwritten formula cell drops its `<f>` and its calcChain entry |
| `bin/cli.mjs import` | `--source <file.xlsx>`: read the workbook, write `import-snapshot.json` and a proposed mapping. `--map`: emit the per-table CSVs of a confirmed mapping. `--accept-proposed`: take the proposal as confirmed, for a run without the page |
| `bin/cli.mjs export --xlsx` | write `<basename>-response.xlsx` from the finished response CSVs — a copy, never the client's original |
| `lib/import-map.mjs` | proposes the mapping from a grid snapshot (which tab is a requirement table, header row, id and answer columns, tokens from the dropdowns), validates what the page confirms, and emits the normalised per-table CSVs |
| `lib/import-state.mjs` | the server's view of the import: what the steering screen renders, and what confirming writes |
| `lib/source.mjs` | reads the client's own per-table CSVs — named by `import-map.json` when the tender came in as a workbook, else the `{03-requirements,04-non-functional-compliance,07-vendor-response-evaluation}.csv` fallback — and joins them by the id column into the columns the §4 grid shows next to our answer; finds each file's header row by scanning for the first row whose first cell is the key column (`ID`, or `#` / `Term` for the context exports `loadContextTables` reads), so an offset header does not need special-casing; server-only, absent folder is not an error |
| `page/` | `index.html`, `app.js`, `app.css`, `vendor/marked.min.js` — vanilla JS, no build |
| `bin/cli.mjs` | the one executable: `start status stop poll emit batch import export guide`. Every other file exports `main(argv)` and never reads `process.argv`, so the commands work through an npx `.bin` symlink |
| `lib/emit.mjs` | `emit progress\|chat\|done "<text>" [--batch id]` — the subagent's only channel to the page |
| `test/` | `node --test test/*.test.mjs` — parser, edit, calc, source, server lifecycle (the last one needs permission to bind `127.0.0.1`). Two fixtures: `rfp-0098-tabs-analysis.md` is the current nine-section grammar, `rfp-0099-mini-analysis.md` the pre-tab seven-section one, kept so the page is proven to still render an older analysis |

## Tabs

The page's primary navigation mirrors the client's own document rather than our section numbering:

| Tab | Shows |
| --- | --- |
| Overview | §2 Summary, confidence, the export gate, and every question no requirement row owns (all partner `Q-n`) |
| Meta | §1.1 Meta, §1.3 Source map, §1.4 Ground truth, §7 Log |
| Company & Context | §1.2 Company & context (key parameters, migration inventory), §3 Global assumptions, §6 Approach |
| Requirements | the §4 rows of every source table that is not the non-functional one — one sub-tab per source table, so a vendor-response sheet's project rows sit beside the requirements |
| Non-functional & Compliance | the §4 rows of the source table the client named so |
| Integrations | §8 |
| Glossary | §9, whose terms are also marked in the requirement text with the client's definition and our mapping |

Panels are rendered once and toggled, never re-rendered, so a patch that lands on a row in a hidden tab is never lost. A tab whose sections the analysis does not carry — anything written before this grammar — says so and names the run that fills it in, instead of showing a blank card.

## Commands

```
sw-tender-discovery-tool guide                                      # the session protocol - the single source, read it first
sw-tender-discovery-tool start  --doc specs/rfp-0001-x-analysis.md  # prints TENDER_TOOL_URL=…, detaches; reattaches if running
sw-tender-discovery-tool start  --doc specs/rfp-0001-x.xlsx         # source path accepted; analysis may not exist yet
sw-tender-discovery-tool status --doc specs/rfp-0001-x-analysis.md  # live summary of GET /api/session; --json for the full payload
sw-tender-discovery-tool poll   --doc specs/rfp-0001-x-analysis.md  # waits up to 90 s -> batch | idle | closed
sw-tender-discovery-tool batch  --kind reconcile                    # replaces the raw POST api/batch curl
sw-tender-discovery-tool import --source specs/rfp-0001-x.xlsx      # read the workbook, propose the mapping
sw-tender-discovery-tool export --xlsx --source specs/rfp-0001-x.xlsx  # write <basename>-response.xlsx, a copy
sw-tender-discovery-tool stop   --doc specs/rfp-0001-x-analysis.md
sw-tender-discovery-tool install-skill                               # write skills/<host>/sw-tender-discovery-tool/SKILL.md; --target <dir>, --print, --force
sw-tender-discovery-tool uninstall-skill                             # remove it again; a copy you edited is kept, not deleted
sw-tender-discovery-tool start --doc … --foreground --grace 60 --agent-timeout 180 --idle 14400
```

Every command finds its session from the document, so none of them takes a URL.
Output is `key: value` lines, then `next_step:`, then any large payload last.
Exit codes: 0 success, 1 server unreachable, 2 usage error.

`<slug>` is the file name without `-analysis.md` or the source extension; it must start with `rfp-NNNN-`. Start needs the analysis or the source to exist.

## Session folder `specs/.editor/<slug>/` (gitignored)

`session.json`, `session.lock` (pid + url while running), `chat.jsonl`, `notes.json` (unsent notes), `batches/<id>.json`, `import-snapshot.json` (the workbook as `import` read it) and `import-map.json` (the steering screen's draft; the confirmed copy is committed next to the CSVs at `<source dir>/<basename>/import-map.json`), `snapshot.json` (frontmatter, hashes, frozen cells, ticks, answers, page-proposed lines at run start), `queue.json` (the durable batch queue: order + the batch in flight), `queued.json` (direct writes waiting for unlock), `proposed.json` (ids of `[ ]` lines the page inserted), `server.log`.

## API (all JSON, localhost only)

| Method & path | Purpose |
| --- | --- |
| `GET /`, `GET /page/*`, `GET /page/lib/calc.mjs` | page, assets, the shared calc module |
| `GET /api/session` | `{session, analysis, source, model, meta, parseError, notes, chat, queued, proposed, sourceColumns}`; `model` is `null` until the analysis exists; `parseError` is `{message, at}` while the file on disk fails to parse (the last good `model`/`meta` stay live); `sourceColumns` is `{available, files, byId, columns, costColumns, fromMap}` from `lib/source.mjs`, re-read when a mapping is confirmed; `importState` carries the imported workbook until its mapping is confirmed |
| `GET /api/events` | SSE: `hello`, `doc` (model, meta, changed/added/removed ids, reason, parseError), `chat`, `progress`, `run`, `agent`, `queued`, `notes`, `closing`; keepalive 15 s |
| `POST /api/heartbeat` | `{tab}` → `{ok, agent, run, lock}`; 60 s without any → server exits |
| `POST /api/notes` | autosave unsent notes |
| `POST /api/tick` | `{id, value:' '\|'x'\|'-'}` → 200 `{changed}` / 202 `{queued, lockedBy}` / 409 `{reason}` (frozen, not found) |
| `POST /api/answer` | `{qid, option?, other?}` single-select; empty clears → 200 / 202 |
| `POST /api/propose` | `{row?, statement, pdSaved?, cls?, riskTo?, rows?, kind: assume\|exclude}` → 200 `{id, line}` / 202; `row` null appends a §3 `A-n` (assume) or `X-n` (exclude) line; `exclude` is global-only and not tickable |
| `POST /api/batch` | `{kind: batch\|reconcile\|analyze\|export, notes?, chat?, remaining?, stage?}` → `{id, file, queued}`; ids `b-N r-N a-N x-N`; `export` → 409 `{reasons}` unless the ready gate holds; `analyze` only while the analysis is missing (or `force`); `stage` (≤120 chars) is stored on the batch for the picking-up agent and shown in the page's run status |
| `GET /api/import/sheet/<index>` | one sheet's full grid, for the steering screen's "show every row" |
| `POST /api/import/map` | saves the steering screen's draft mapping and broadcasts `import` |
| `POST /api/import/confirm` | writes the normalised CSVs and the committed mapping, re-reads the client columns, and enqueues one ordinary batch (`kind: batch`, `stage: import`) |
| `POST /api/run/abort`, `POST /api/close`, `GET /api/lock` | abort the active run (unlock, apply queued), end the session, lock + agent + queue |
| `GET /api/next?wait=<s>` | **agent** long-poll → `{event:"batch"}` / `idle` / `closed`; reserves the batch, locks and snapshots. The reservation is only final once the agent acknowledges it through one of the `/api/agent/*` endpoints: a poll that dies before the response is written rolls it back, and an unacknowledged run is re-delivered to the next poll, so a killed `poll` never loses a batch |
| `GET /health` | package name and version, pid, slug, url, start time. `start` probes it: a matching version reattaches, a different one is stopped and restarted |
| `POST /api/agent/progress` / `chat` / `reply` | **agent** progress line, interim message, final reply (verify + repair, diff vs snapshot, reload, unlock, apply queued) |

## Direct writes

Every write re-reads the file from disk, changes one line through `lib/edit.mjs`, writes atomically (`.tmp` + rename; the watcher ignores `.tmp`) and pushes a `doc` event. While a run holds the lock the write is stored in `queued.json` (202), later ticks on the same id replace earlier ones, and everything is applied in order after the reply or abort; a write the file no longer accepts is dropped with a `system` chat line. A frozen line (`accepted` / `rejected`) is never changed by the page.

## Agent channel

The skill loop calls `GET /api/next` and spawns one subagent per batch file (`{id, kind, sentAt, session, analysis, source, slug, notes, chat, pending:{ticks, answers, proposals}, context, file}`). The subagent edits the analysis directly and reports through `bin/cli.mjs emit`; `done` triggers the repair pass (frontmatter, frozen cells, human ticks, page-proposed lines) and releases the lock. Presence flips (`agent` events, `--agent-timeout`) never abort a run; only `POST /api/run/abort`, an `abort` reply or Stop does.
