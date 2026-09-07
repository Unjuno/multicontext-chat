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
using textContent rather than model paraphrase/HTML. The GUI write workflow remains
pending; current write access is REST/MCP.
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
Source-message trimming, note correction/supersession, and UI write workflow still
need lifecycle treatment. Existing notes retain source excerpts/hashes if originals
are later trimmed. Never silently rewrite earlier reviews to make a report look correct.
