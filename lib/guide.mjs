// `guide` - the session protocol, printed by the CLI.
//
// This is deliberately the ONLY place the protocol is written down. A copy
// inside a skill file goes stale the moment the CLI changes and the agent has
// no way to tell which one is current, so the skills stay stubs that say "run
// `guide` and follow it".

import * as out from './out.mjs';

const GUIDE = `
Tender Discovery Tool - session protocol

The operator works a tender analysis on a local page: reviewing your
extraction into the tool's own tabs, confirming scope items, accepting or
rejecting proposed assumptions, answering client questions, editing the
Client Response and Internal note, and running the partner-profile wizard.
You do the analysis, estimation and the extraction itself. The page is their
side; this CLI is yours. Page actions are never batches - see step 2.

0. IF THE TENDER IS AN XLSX OR CSV WORKBOOK, IMPORT IT FIRST
   sw-tender-discovery-tool import --source specs/rfp-NNNN-slug.xlsx
   Reads the workbook (hidden sheets, merges and the dropdown lists a CSV export
   would lose) and writes an import digest naming every visible sheet, its own
   proposed table shape and compliance tokens. Nothing is confirmed here: the
   digest is only a starting point. next_step: tells you to run the
   sw-tender-editor extract job on the digest, producing an extraction JSON
   (contract's tables/overrides/skip/items/projectInfo shape), then run
   sw-tender-discovery-tool intake <doc> --source <file> --extraction <json>
   This builds §4 into the tool's own three fixed tabs (Functional,
   Non-functional, Project & services), fills §1 Project information and
   Not taken, then confirms itself (sets the document's intake state to
   "confirmed") and queues the opening analyze batch automatically - no
   operator step in between. For a PDF source, skip \`import\` and run the
   extract job straight on the PDF, then the same intake command with the
   PDF as --source.

1. START THE PAGE
   sw-tender-discovery-tool start --doc specs/rfp-NNNN-slug-analysis.md
   The client's source file works too when the analysis does not exist yet -
   opening one with no working document yet queues the opening \`intake\`
   batch itself; poll returns it right away, with no button for the operator
   to click first. \`--no-intake\` opts out and leaves the page's
   "Start intake" button as the only way to start it. Prints
   TENDER_TOOL_URL=<url>. Starting a second time reattaches instead of binding
   a second port, and never queues a second opening intake batch. Give the
   URL to the user and ask them to open it.

2. PAGE ACTIONS ARE NOT BATCHES
   The runtime applies these directly, from the page or from the command line -
   never by spawning an agent:
     sw-tender-discovery-tool intake-confirm <doc>
     sw-tender-discovery-tool move     <doc> <id> <tab> [--topic "<t>"]
     sw-tender-discovery-tool skip     <doc> <id> "<why>"
     sw-tender-discovery-tool restore  <doc> "<source>"
     sw-tender-discovery-tool info     <doc> <key> "<value>"
     sw-tender-discovery-tool confirm   <doc> <id>... | --all-unconfirmed
     sw-tender-discovery-tool unconfirm <doc> <id>...
     sw-tender-discovery-tool accept   <doc> <P-n>
     sw-tender-discovery-tool reject   <doc> <P-n>
     sw-tender-discovery-tool assume   <doc> <item|global> "<statement>"
     sw-tender-discovery-tool unassume <doc> <item> "<statement>"
     sw-tender-discovery-tool answer   <doc> <CQ-n> <key>
     sw-tender-discovery-tool patch    <doc> <id> [--response "<t>"] [--note "<t>"]
     sw-tender-discovery-tool profile  <doc> --file profile.json   # writes var/sw-ai-sdk/tender/partner-profile.md, shared by every tender in the project
     sw-tender-discovery-tool tokens   <doc> --suggest | --file tokens.json
     sw-tender-discovery-tool export   <doc> [--out <file>]
   Intake confirms itself and queues analysis on its own - no operator step
   in between. The operator can move an item to another tab/topic, skip one
   (with a reason) or restore a skipped one, and edit a Project information
   value, at any time, through a queued row note; the page's Overview banner
   shows the Not-taken rows (each with a Restore button), unused sheets and
   the answer targets per client table whenever any exist. Skipping a
   confirmed item is refused with reason "unconfirm first" - run unconfirm <doc>
   <id> first if that is really what is wanted (it reopens the item; the
   page's confirmed tick doubles as an unconfirm button, no dialog). Analysis
   runs in chunks of
   up to 45 items, in the page's own order (top of the first tab first); each
   chunk applies as it lands and the next is queued the moment the previous
   one finishes, until nothing is left.
   \`intake-confirm <doc>\` still exists, only for a document still at
   "review" - an old one, from before this behaviour. It confirms it and
   queues analyze the same way, or reports "already confirmed" otherwise;
   opening a session on such a document confirms it for you. \`analyze\` is
   refused while intake is "review", since only such a legacy document can be
   in that state.
   Export is available anytime; unconfirmed scope items export with empty
   answer cells. For an xlsx source, a requirements table with a compliance
   column needs its Requirement Coverage -> client-token map before export
   writes real client tokens (RC-4) - see step 5's "export" kind. Every export
   writes a fresh <base>-response-v<n>.xlsx and never overwrites an existing
   file; the run prints the version and what changed since the last export,
   and appends a Log line.

3. QUEUE WORK, OR WAIT FOR IT
   sw-tender-discovery-tool batch --kind intake        re-run the extraction the operator asked to redo
   sw-tender-discovery-tool batch --kind analyze       assess the next chunk of items needing work (refused while intake is "review")
   sw-tender-discovery-tool batch --kind reestimate    re-run the items reestimate.json names (or all, item "*")
   sw-tender-discovery-tool batch --kind notes         apply an annotation or chat instruction only
   sw-tender-discovery-tool batch --kind export        map Requirement Coverage -> client tokens, then export
   The server queues \`analyze\` itself once intake is confirmed and there is
   work to do (a queued/reopened item, or a reestimate.json mark), and again
   after every chunk finishes, until nothing is left - running \`batch --kind
   analyze\` by hand is rarely needed. The user queues their own batches from
   the page. A \`notes\` batch queued while intake is "review" re-runs the
   extraction instead of just filing the note. \`POST /api/export\` queues an
   \`export\` batch itself when coverage tokens are missing and you are
   present.

4. POLL
   sw-tender-discovery-tool poll
   Waits up to 90 s, then returns one of:
     event: batch    a batch file to act on; read batch_file, then do the work
     event: idle     nothing yet - run poll again
     event: closed   the session is over - stop polling
   Follow the next_step line in the output.

   sw-tender-discovery-tool poll --reply "<text>"
       closes the active batch (same effect as "emit done") and falls straight
       into the wait for the next one - one call instead of "emit done" then a
       separate "poll".

   Poll rules:
   - Keep poll in the foreground of the active turn. Never background it with
     nohup, &, or a detached shell: the harness does not wake you when a
     background command finishes, so the batch would sit unanswered.
   - poll is safe to re-run after being killed. A batch is redelivered until
     you acknowledge it by calling emit (progress, chat or done) - a killed
     poll never loses a batch; re-running poll just returns the same one.
   - Do not raise your command timeout for it. The 90 s bound exists so the
     default timeout is always enough.

5. WORK
   A batch locks the analysis while it runs. The kind decides what you run:
     intake      spawn the sw-tender-editor extract job (over the import
                 digest for xlsx/csv, or straight over the source for a PDF)
                 to produce a fresh extraction JSON, then
                 \`intake <doc> --source <file> --extraction <json>\`;
                 --source is always required, even for a PDF, so
                 source-sha256 covers the file; this confirms intake again
                 and queues analysis for whatever needs it
     analyze     assess exactly the batch's \`items\` (KB checks, coverage,
                 effort, proposals, client questions), applying each report as
                 soon as it is ready rather than waiting for the whole chunk -
                 \`apply <doc> --report <json>\` per group. Every Configuration/
                 Extension/ISV/Custom item needs at least one proposal or a
                 \`noProposal\` reason; \`apply\` refuses one with neither
     reestimate  the same assess-then-apply cycle, limited to the items
                 reestimate.json names
     notes       apply the queued annotations and/or chat text; no item is
                 re-assessed
     export      run \`tokens <doc> --suggest\`, decide the six-value ->
                 client-token map per requirements table from the client's own
                 token meanings, run \`tokens <doc> --file <json>\`, then
                 \`export <doc>\`; post the file path and the map you chose
   Never write into a confirmed item's Client Response or Internal note except
   through \`patch\`; never edit the client's file.

   The batch JSON carries: id, kind (intake | analyze | reestimate | notes |
   export), analysis, source, notes (each entry id, kind comment, file, block,
   blockKind, line, endLine, quote, optionally selection, plus text), chat,
   context (chat log path) and file (its own path). An analyze batch also
   carries items: the ids to assess this chunk, in page order - assess only
   these, never the whole document.

6. TALK BACK
   sw-tender-discovery-tool emit progress "<step>" --batch <id>
       one status line; also tells the page you are still alive
   sw-tender-discovery-tool emit chat "<markdown>" --batch <id>
       an interim message; the run stays active
   sw-tender-discovery-tool emit done --batch <id> -
       the final answer; releases the lock. Body on stdin - post it with a
       heredoc so markdown stays intact:
         sw-tender-discovery-tool emit done --batch <id> - <<'EOF'
         <report>
         EOF
       If the run failed, still post one line ("Run failed: <one line>") so
       the lock is released rather than left hanging.

   EVERY BATCH ENDS THE SAME WAY, whatever kind it was:
     sw-tender-discovery-tool check <doc> --write
     sw-tender-discovery-tool report <doc>
   \`check --write\` regenerates section 2's totals and the document's
   In progress/Ready state, refusing with reasons first. \`report\` prints the
   run report (state, confirmed of total, failed, open client questions, not
   decomposed, low confidence, effort by priority with its regime, waiting
   proposals, what changed) and writes last-run.json. Post that report as the
   batch's reply with \`emit done\`.

7. CLOSE
   sw-tender-discovery-tool stop --doc <path>
   The server also exits by itself, but not right away: once the page's
   heartbeat has been missing for --grace seconds it opens a 10-minute close
   grace, so a closed tab, a reload or a laptop sleep can reconnect and
   resume the same session; only after that grace does poll report \`closed\`
   and the server exit. It also exits after --idle seconds (default 14400 =
   4h) without a batch, poll, reply or page write.
   Then summarise the session for the user: state, confirmed of total, what is
   still pending, and the chat log path.

sw-tender-discovery-tool status --doc <path>
    reads session state without a URL: running, analysis found/missing,
    run_active, and more behind --json. This is the current way to check the
    session; there is no other read channel.

State lives in specs/.editor/<slug>/ and is gitignored. The queue itself
(specs/.editor/<slug>/queue.json) is durable and survives a server restart.
Proposals, pending re-estimates and the last run's snapshot live in
specs/.rfp/<slug>/, also gitignored. The session is found from the document,
so no command takes a URL.

Exit codes: 0 success, 1 server unreachable, 2 usage error.
`;

const CODEX_NOTE = `
Codex detected. Your sandbox may block the loopback bind that \`start\` needs and
the npx fetch that installs this CLI. If \`start\` cannot bind 127.0.0.1, say so
plainly and fall back to working through the analysis in chat rather than
retrying.
`;

export function main() {
  out.nextStep('run `sw-tender-discovery-tool start --doc specs/rfp-NNNN-slug-analysis.md` (or the client\'s source file)');
  out.payload(GUIDE.trim());
  if (process.env.CODEX_SANDBOX || process.env.CODEX_THREAD_ID) out.payload(CODEX_NOTE.trim());
}
