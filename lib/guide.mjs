// `guide` - the session protocol, printed by the CLI.
//
// This is deliberately the ONLY place the protocol is written down. A copy
// inside a skill file goes stale the moment the CLI changes and the agent has
// no way to tell which one is current, so the skills stay stubs that say "run
// `guide` and follow it".

import * as out from './out.mjs';

const GUIDE = `
Tender Discovery Tool - session protocol

The architect reviews a tender analysis on a local page: ticking assumptions,
answering questions and proposing lines. You do the analysis and estimation.
The page is their side; this CLI is yours.

0. IF THE TENDER IS AN XLSX WORKBOOK, IMPORT IT FIRST
   sw-tender-discovery-tool import --source specs/rfp-NNNN-slug.xlsx
   Reads the workbook (hidden sheets, merges and the dropdown lists a CSV export
   would lose) and proposes which tabs are requirement tables, where each header
   row sits and what each column means. Nothing is guessed silently: the mapping
   is a human decision.
   Confirm it on the page (step 1, --editor), or - if the proposed table is
   already right - re-run with --map --accept-proposed to confirm from the
   command line. Confirming writes the normalised per-table CSVs the analysis
   reads. CSV, markdown and PDF tenders skip this step.

1. START
   sw-tender-discovery-tool start --doc specs/rfp-NNNN-slug-analysis.md
   The client's source file works too (specs/rfp-NNNN-slug.csv|md|txt|pdf|xlsx)
   when the analysis does not exist yet. Prints TENDER_TOOL_URL=<url>.
   Starting a second time reattaches instead of binding a second port.
   Give the URL to the user and ask them to open it.

2. NOTHING RUNS ON OPEN
   Opening the page reconciles nothing. You act only when a batch arrives.

3. QUEUE WORK, OR WAIT FOR IT
   sw-tender-discovery-tool batch --kind analyze        build the analysis
   sw-tender-discovery-tool batch --kind reconcile      re-read the ticks
   sw-tender-discovery-tool batch --kind export         write the response files
   The user queues their own batches from the page.

   Two different things share the word "export":
     batch --kind export   queues a batch that writes the response CSVs
     export --xlsx         writes the client's workbook back out (step 7)

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
   A batch locks the analysis. While it is locked the architect's ticks,
   answers and proposals are queued and applied when you release it. Edit the
   analysis directly; the page reloads it.

   The batch JSON carries: id, kind (analyze | reconcile | batch | export),
   analysis, source, notes (each kind comment | free, text, and for
   block-bound notes the locator block, blockKind, path, line-endLine, md,
   quote, hash, optionally selection), chat, pending (ticks, answers,
   proposals the page wrote into the file), context (chat log path) and file
   (its own path).

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
       The server verifies the file against its pre-run snapshot and repairs
       anything the agent dropped: a reverted tick, an altered frozen line, a
       dropped page-proposed line, a missing frontmatter block.

7. HAND BACK THE CLIENT'S WORKBOOK (xlsx tenders)
   sw-tender-discovery-tool export --xlsx --source specs/rfp-NNNN-slug.xlsx
   Writes <basename>-response.xlsx - a COPY, with the answers filled in and
   every untouched part of the file byte-identical. The client's original is
   never modified. Needs a confirmed mapping from step 0 and the finished
   response CSVs from \`batch --kind export\`.

8. CLOSE
   sw-tender-discovery-tool stop --doc <path>
   The server also exits by itself when the page has been gone for 60 s, and
   after --idle seconds (default 14400 = 4h) without a batch, poll, reply or
   page write.
   Then summarise the session for the user: status, confidence, what is still
   pending, and the chat log path.

sw-tender-discovery-tool status --doc <path>
    reads session state without a URL: running, analysis found/missing,
    pending ticks/answers/proposals, run_active, and more behind --json. This
    is the current way to check the session; there is no other read channel.

State lives in specs/.editor/<slug>/ and is gitignored. The queue itself
(specs/.editor/<slug>/queue.json) is durable and survives a server restart.
The session is found from the document, so no command takes a URL.

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
