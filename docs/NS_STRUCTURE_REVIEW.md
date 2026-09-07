# Local NS structural exploration: independent review

Experiment: `data/experiments/ns-structure-1788822328816` (ignored local evidence).
Reproduce with `MULTICONTEXT_BACKEND=local node scripts/experiment-ns-structure.mjs`.
This uses actual loopback GPT-OSS 20B, no account/key, three isolated roles,
two parallel initial queue items and a subsequent peer-review item.
Runtime: SETTLED in 46,083 ms; 7 model requests; 10,399 prompt + 2,712 completion
tokens (13,111 total, reported by the local server). No comparative cost/speed
claim against a cloud model or a single-role baseline has been established.

## Outcome: useful discovery, rejected reasoning

The roles located real strain-eigenvalue literature, but their conclusions are not
accepted as verified knowledge:

- Literature locator: three actual searches (two web, one Crossref). It asserted
  a verbatim Question 1.1 and a section location despite no full-text fetch. It also
  inferred absence of a DOI from a keyword search that did not return the target.
  These claims are unsupported; a returned search snippet is not a journal visit.
- Designer: one actual Crossref search. It proposed the squared L2 norm of the
  positive middle strain eigenvalue as an integrable regularity criterion. This
  confuses the required time exponent. It also asserted an incorrect pointwise
  strain/vorticity identity and treated heuristic reasoning as rigorous.
- Critic: zero search calls; it nonetheless claimed a fresh Crossref/full-text
  check and endorsed the erroneous derivation. Separate roles did not provide
  independent verification on this run.

The orchestrator checked [Miller's paper, Theorem 1.1](https://arxiv.org/pdf/1710.05569):
the condition uses 2/p + 3/q = 2. For spatial q=2 this gives temporal p=4, not 2.
The paper explicitly labels the vorticity-alignment argument around (1.27)-(1.29)
as heuristic. This contradicts the generated report's claim of a rigorous derivation.
Independently, the matrix decomposition gives |grad u|^2=|S|^2+|curl u|^2/2;
the generated alternative identity fails even for a nonzero symmetric trace-free
gradient at a point. These checks reject the report; they do not prove a new theorem.

Next useful research action: inspect the proof using the strain determinant and
the range of integrability exponents, rather than recycling the rejected L2-time
criterion. A source discovery is worth retaining; its invented theorem is not.
The Millennium problem has not been solved by this experiment.

## Harness correction and preserved evidence

The first harness filtered returned source by `papers` (the request enum), but
the provider's returned label is `Crossref`. Its final assertion therefore reported
zero searched members incorrectly. The script is corrected. Recheck the original
trace with `node scripts/inspect-research-evidence.mjs DIRECTORY`; this writes a
new hash-attributed audit without rerunning the model or replacing the old results.
Correct counts are 3 / 1 / 0. Even with the harness fixed, the requirement that all
three roles actually search fails. The failed run must not be relabeled PASS.

Three explicit rejection notes were appended through canonical `addReviewNote`
to the recorded workspace, retaining the source message IDs and rationale. Source
messages and queues were compared byte-for-byte as JSON and remained unchanged.

## Application improvement from this run

Scheduler-observed built-in search outcomes now accompany each completed answer
and are included in synthesis inputs. The GUI displays their counts separately
from the model's prose. Empty, failed, successful, and unrecorded searches differ.
The scope is this execution attempt's MultiContext search, not older context,
LibreChat/provider-owned tools, or all possible external activity. Success is
discovery only, never full-text or mathematical verification. Per-answer records
retain up to eight call summaries plus omitted counts; they survive state reload.
This is observability, not automatic enforcement that every role searches.

Real follow-up `research-flywheel-1788822598252` exercised built-in search, actual
cross-chat delivery, auditor exact-DOI lookup, and persisted evidence for both
completed answers. Runtime acceptance passed. This verifies the direct-local
backend, not the legacy LibreChat provider-owned mixed-tool path or native GUI.

Validation after the change: `npm run check` 325 total / 322 passed / 0 failed /
3 skipped; `npm run verify:bundle` passed. Tests cover real Scheduler propagation,
model-provided fake evidence being ignored, distinct missing/empty/failed outcomes,
bounded call details, state reload, synthesis input, and deterministic display text.
Browser/native rendering of the new label still needs a direct GUI pass.
