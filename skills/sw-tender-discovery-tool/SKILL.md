---
name: sw-tender-discovery-tool
description: Open a tender analysis (specs/rfp-NNNN-slug-analysis.md) or a client workbook (specs/rfp-NNNN-slug.xlsx) in the Tender Discovery Tool — a local live HTML page where the agent's extraction into the tool's own fixed tabs confirms itself and analysis starts automatically, the operator corrects it at any time through row notes (move, skip, restore), confirms scope items, accepts or rejects proposed assumptions, answers client questions, edits the Client Response and Internal note in place, and runs the partner-profile wizard — and run the session loop that hands every batch (intake, analyze, reestimate, notes, export — tokens mapped agentically at export) to sw-discover-tender and posts its report back to the page. Backs the `--editor` flag of sw-discover-tender and its `.xlsx` import. Opening a source with no working document yet starts intake automatically (`--no-intake` opts out); once an analysis exists, a scope item changes only when the operator confirms it or a batch runs. Long-running: stays until the page is closed or the user stops it, with a 10-minute grace after the page goes quiet so a reload or dropped tab can resume the same session.
when_to_use: Trigger phrases — "open the tender tool", "open RFP 0001 in the browser", "sw-discover-tender specs/rfp-0001-x-analysis.md --editor", "review the extraction on the page", "review the tender analysis in the browser".
argument-hint: [specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.xlsx]
allowed-tools: Read Glob Grep Skill Bash(npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.2.0 *) Bash(open *) Bash(xdg-open *) Bash(grep *) Bash(printf *) Bash(tail *)
license: MIT
metadata:
  author: Execuro UG (haftungsbeschränkt)
  package: "@execuro-sw-ecosystem/sw-tender-discovery-tool@0.2.0"
---

# sw-tender-discovery-tool

The operator reviews a tender analysis on a local page and sends you work; you do the analysis and estimation and answer back. This skill runs that loop. It never writes the analysis itself and never asks a question in the terminal while the page is open — every content change goes through `sw-discover-tender`.

## The protocol lives in the CLI, not in this file

Do not follow a session procedure from this file — an installed copy goes stale against a newer CLI. Run this once, then follow what it says:

```
npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.2.0 guide
```

It is the single source for the xlsx import, start, the batch kinds, poll, emit and close, for the poll rules, and for the batch's fields. Every command also ends with a `next_step:` line; follow it. The CLI prints its own name bare (`sw-tender-discovery-tool poll`) — run each one as `npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.2.0 poll`.

## Inputs

| Argument | Behaviour |
| --- | --- |
| `specs/rfp-NNNN-slug-analysis.md` | Opens the existing analysis |
| `specs/rfp-NNNN-slug.xlsx` | The client's workbook: `guide` step 0 imports it, runs the extract job over the digest and builds §4 with `intake`; the opening `intake` batch does this, confirms itself and queues the first analyze chunk automatically — the operator corrects the result on the page at any time (a queued note to move or skip a row, restore, Project information) |
| `specs/rfp-NNNN-slug.{csv,pdf}` | The client's source with no analysis yet; §4 is built the same way by the first `intake` batch, which confirms itself and queues analysis the same way |
| Nothing | Ask once for the path, then proceed |

Both names map to one session — the slug is the file name up to `-analysis`, so the workbook and its sidecar never open two pages.

## What this skill adds to the protocol

`guide` tells you how to run a session. This is who does the work when a batch arrives: spawn ONE subagent (general-purpose) with a brief that runs **`sw-discover-tender`** with the Skill tool, invoked as

```
sw-discover-tender <analysis or source path> --editor-session <url> --batch-file <batch file>
```

The batch's `kind` decides what that run does — `intake` extracts scope items into the tool's own tabs (an extraction JSON, then `intake --extraction`) and confirms the document itself, `analyze` assesses exactly the batch's `items` — the next chunk of scope items needing work, in page order, queued automatically once intake confirms itself and again after every chunk finishes, never a manual step (refused only while an old document is still under legacy review), `reestimate` re-assesses the items `reestimate.json` names, `notes` applies the queued annotations and/or chat only — any queued accept/reject decision on a suggested assumption already landed before this batch was even sent (the server applies it as part of enqueueing the `notes` batch); never re-apply one from the batch payload — a move or skip note applies at any time, refused with "unconfirm first" on a confirmed item's skip — the operator's own `unconfirm` (a second click on the row's confirm tick, or the CLI op) reopens it, no batch involved (or re-runs the extraction if queued on a document still under legacy review), `export` maps the Requirement Coverage → client-token map (`tokens --suggest`/`--file`) then runs `export` (`guide` names each kind's exact fields). You do not need to know what `sw-discover-tender` does with a given kind, only to pass the batch file through. Every run ends the same way, whatever the kind: `check <doc> --write` then `report <doc>`.

When the subagent returns, post its report as the reply. If it fails or returns nothing usable, still post a reply (`Run failed: <one line>`) so the lock is released.

Nothing goes to the terminal during a batch beyond what the tools print — the user is reading the page.

## Notes

- This skill drives the page. The tender *method* — classification, estimation (one PD/size figure per item, T-shirt or profile regime), the assumption catalogue, the response rules — lives in `sw-discover-tender`, not here, and is not restated in this file.
- A run that spawns helper agents can stay silent for a while. The server never aborts a run for silence, but emit progress before and after every spawn wave so the page's presence indicator stays alive.
- Everything under `specs/.editor/` and `specs/.rfp/<slug>/` is session state and gitignored. The working document itself is committed, and so is the fit-back map (`<source dir>/<basename>/import-map.json`) `intake` writes for an xlsx source — it is what `export` uses to write each confirmed item back into the client's own sheet and row.
- The response workbook is written as a **copy**, never overwritten: each export is a fresh, numbered `<base>-response-v<n>.xlsx`, and the client's original file is never modified. Export is available anytime; an unconfirmed scope item exports with empty answer cells. An xlsx source's requirements table with a compliance column needs its Requirement Coverage → client-token map first (`export` kind, above); the page queues that batch itself when it is missing.
- `export` needs Node >= 20.15 (`zlib.crc32`) for an xlsx source.
