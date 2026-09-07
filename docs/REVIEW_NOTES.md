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
using textContent rather than model paraphrase/HTML. GUI creation controls and
full REST/MCP differential tests remain pending; current write access is REST/MCP.

Observed experiment `research-summary-1788821750896`: a copied NS workspace received
a targeted rejection of incorrect exponents and was compiled with direct GPT-OSS.
The model retained the rejection ID but incorrectly paraphrased the valid Young
exponents as invalid. This is why the immutable review record is shown separately.
The feature improves provenance retention; it does not prove model compliance or
prevent every misuse of a rejected assertion. Source histories remained unchanged.

Notes persist across restart and are included in state backup. Workspace duplication,
source-message trimming, note correction/supersession, and UI write workflow still
need lifecycle treatment. Existing notes retain source excerpts/hashes if originals
are later trimmed. Never silently rewrite earlier reviews to make a report look correct.
