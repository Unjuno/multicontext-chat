# Attributable review notes

REST: `POST /api/workspaces/:id/reviews` under normal REST auth.
MCP: `multicontext_add_review_note` under normal MCP auth.
Both use canonical `addReviewNote`. Fields: memberId, messageId, verdict
(`supported`, `rejected`, `needs_check`), rationale, reviewer. Reviewer is explicitly
self-reported, not authenticated identity; no verdict certifies a theorem.

Records append without changing source messages, member queues, or dispatching
work. Each retains timestamp, source ID/hash and bounded excerpt. Maximum 100 per
workspace; rationale capped at 2000 characters. Latest eight are included in Compile,
with omitted counts. GUI shows recent original review text beside the summary,
using textContent rather than model paraphrase/HTML. Each non-pending source message
also offers a GUI review dialog and displays its latest three original reviews,
even before Compile. The dialog submits through the same REST/canonical operation
as MCP, captures the original workspace/member/message IDs, and does not dispatch work.
Drafts live outside the periodically replaced workspace DOM; expanded reviews remain
open across updates. Error messages preserve inputs; failed saves are not auto-retried.
Reviewer labels remain self-reported and no verdict certifies a proof.
The REST/MCP integration regression test calls both real HTTP transports, compares
stored record fields (excluding generated ID/time), checks REST authentication,
and confirms invalid sources/verdicts leave state unchanged. It also verifies that
member histories and queues are unchanged. This uses a mock model, not a GUI pass.

Observed experiment `research-summary-1788821750896`: a copied NS workspace received
a targeted rejection of incorrect exponents and was compiled with direct GPT-OSS.
The model retained the rejection ID but incorrectly paraphrased the valid Young
exponents as invalid. This is why the immutable review record is shown separately.
The feature improves provenance retention; it does not prove model compliance or
prevent every misuse of a rejected assertion. Source histories remained unchanged.

Notes persist across restart and are included in state backup. Workspace duplication
assigns new member IDs and dictionary keys together, remaps review member references,
and retains copiedFrom workspace/review/member provenance without rewriting evidence.
Regression tests verify copied notes enter synthesis and new reviews can target copied
messages, while the source workspace remains unchanged. Existing previously broken
copies are not migrated by this change. Historical message contents remain unchanged.
Source-message trimming and note correction/supersession still
need lifecycle treatment. Existing notes retain source excerpts/hashes if originals
are later trimmed. Never silently rewrite earlier reviews to make a report look correct.

## Browser/MCP differential check (2026-09-08 JST)

Used an isolated copy of `research-flywheel-1788822598252/state.json`, served by
the current Node app on loopback with the real HTTP MCP transport. No provider
generation was requested and the original experiment data was not changed.

- Discovered 33 MCP tools; listed and read the expected SETTLED workspace.
- MCP added note `ae4d339b-354e-400f-a58a-e28ddee9c765`; browser displayed its
  original text under the corresponding assistant message before any Compile.
- Browser form accepted multiline input and Enter-key submission. MCP read back
  note `cd0cfc5d-92be-4b7f-a2f8-8f395fd13f79` with the exact target, rationale,
  and self-reported reviewer. Messages, queues, and execution stats were unchanged.
- Literal `<b>` markup remained text; it was not rendered as HTML.
- Manual workspace refresh preserved the expanded review disclosure.
- Escape closed an empty review dialog without saving; Enter in the reviewer
  input submitted through the form. Draft contents survived periodic page updates.
- Search counts remained visible separately from model prose. The dialog was
  inspected visually and its layout adjusted to center it within the viewport.

This is a current browser UI + real MCP/REST transport check, not a newly rebuilt
Tauri app/signing/notarization test. Browser automation used the available Computer
API because the agent-browser CLI was unavailable. For repeated state/operation
checks, prefer MCP; keep direct GUI checks for rendering and input behavior.
The reviewed copy is retained in `data/experiments/gui-review.F9HJ4M/state.json`
(ignored local evidence). Automated check: 327 total / 324 passed / 0 failed /
3 skipped. UI unit tests cover exact target mapping, invalid input boundaries,
HTML escaping, bounded disclosure content, and preserved expansion markup.

## MCP knowledge handoff

`orchestrate_extract_findings` and both scopes of `orchestrate_distill_context`
now retain review annotations and explicitly label output `UNREVIEWED`. These
operations extract records, not verified knowledge. Previously the excerpts lost
the review context. Chat-message reads also retain scheduler search evidence;
legacy messages are explicitly unrecorded rather than inferred to have searched.

The latest eight scoped reviews are retained with an omitted count. Distilled text
contains rationale excerpts capped at 400 characters with explicit truncation;
the structured review records retain full rationales. Distilled text is capped at
8000 characters (not tokens) and marks whole-output truncation. Source excerpts
include message ID, role, pending status, and search evidence. Read omitted records
before reuse; none of these labels prevent a model from ignoring a rejection.

`node scripts/smoke-research-handoff.mjs data/experiments/ns-structure-1788822328816/state.json`
passed against a copied real experiment using the actual MCP HTTP transport:
three rejection notes survived workspace extraction/distillation, and the selected
chat retained its one scoped note. Source and copied state bytes stayed unchanged;
model requests were zero. This is extraction verification, not new mathematical
verification or an updated running desktop installation.
