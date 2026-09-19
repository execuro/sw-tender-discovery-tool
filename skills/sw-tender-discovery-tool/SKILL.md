---
name: sw-tender-discovery-tool
description: Open a tender analysis (specs/rfp-NNNN-slug-analysis.md) or a client workbook (specs/rfp-NNNN-slug.xlsx) in the Tender Discovery Tool — a local live HTML page where the architect confirms the workbook's column mapping, ticks proposed assumptions, answers open questions, proposes their own lines and watches the projected effect of unreconciled ticks — and run the session loop that hands every batch to sw-discover-tender and posts its report back to the page. Backs the `--editor` flag of sw-discover-tender and its `.xlsx` import. Nothing runs on open: the analysis is reconciled only when the architect sends something. Long-running: stays until the page is closed or the user stops it.
when_to_use: Trigger phrases — "open the tender tool", "open RFP 0001 in the browser", "sw-discover-tender specs/rfp-0001-x-analysis.md --editor", "confirm the xlsx mapping on the page", "review the tender analysis in the browser".
argument-hint: [specs/rfp-NNNN-slug-analysis.md | specs/rfp-NNNN-slug.xlsx]
allowed-tools: Read Glob Grep Skill Bash(npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.1.1 *) Bash(open *) Bash(xdg-open *) Bash(grep *) Bash(printf *) Bash(tail *)
license: MIT
metadata:
  author: Execuro UG (haftungsbeschränkt)
  package: "@execuro-sw-ecosystem/sw-tender-discovery-tool@0.1.1"
---

# sw-tender-discovery-tool

The architect reviews a tender analysis on a local page and sends you work; you do the analysis and estimation and answer back. This skill runs that loop. It never writes the analysis itself and never asks a question in the terminal while the page is open — every content change goes through `sw-discover-tender`.

## The protocol lives in the CLI, not in this file

Do not follow a session procedure from this file — an installed copy goes stale against a newer CLI. Run this once, then follow what it says:

```
npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.1.1 guide
```

It is the single source for the xlsx import, start, the batch kinds, poll, emit and close, for the poll rules, and for the batch's fields. Every command also ends with a `next_step:` line; follow it. The CLI prints its own name bare (`sw-tender-discovery-tool poll`) — run each one as `npx -y @execuro-sw-ecosystem/sw-tender-discovery-tool@0.1.1 poll`.

## Inputs

| Argument | Behaviour |
| --- | --- |
| `specs/rfp-NNNN-slug-analysis.md` | Opens the existing analysis |
| `specs/rfp-NNNN-slug.xlsx` | The client's workbook: `guide` step 0 imports it and the page carries the mapping screen the architect confirms before anything is analysed |
| `specs/rfp-NNNN-slug.{csv,md,txt,pdf}` | The client's source with no analysis yet; the analysis is built by the first batch |
| Nothing | Ask once for the path, then proceed |

Both names map to one session — the slug is the file name up to `-analysis`, so the workbook and its sidecar never open two pages.

## What this skill adds to the protocol

`guide` tells you how to run a session. This is who does the work when a batch arrives: **`sw-discover-tender`**, in this session, with the Skill tool, called as

```
sw-discover-tender <analysis or source path> --editor-session <url> --batch-file <batch file>
```

The batch's `kind` decides what that run does — `analyze` builds the analysis from the client's source, `reconcile` re-reads the ticks, `batch` carries the architect's notes, `export` writes the response files. `sw-discover-tender`'s own `reference/agent-briefs.md` maps each kind to the brief it runs; you do not need to know that mapping, only to pass the batch file through.

Post its report as the reply. If it fails or returns nothing usable, still post a reply (`Run failed: <one line>`) so the lock is released.

Nothing goes to the terminal during a batch beyond what the tools print — the user is reading the page.

## Notes

- This skill drives the page. The tender *method* — classification, the three-point estimate, the assumption catalogue, the confidence rubric, the response rules — lives in `sw-discover-tender`, not here, and is not restated in this file.
- A run that spawns helper agents can stay silent for a while. The server never aborts a run for silence, but emit progress before and after every spawn wave so the page's presence indicator stays alive.
- Everything under `specs/.editor/` is session state and gitignored. The normalised source CSVs and `import-map.json` under `<source dir>/<basename>/` are committed on purpose.
- The response workbook is written as a **copy**; the client's original file is never modified.
- `export --xlsx` needs Node >= 20.15 (`zlib.crc32`). Below that the response CSVs still work.
