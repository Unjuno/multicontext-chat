# Research orchestration A/B record

This experiment compares orchestration methods. It does not test whether a local
model can solve the three-dimensional Navier-Stokes regularity problem, and no
output in these records is a proof.

## Compared methods

- **A — independent parallel:** three isolated personas each perform an exact
  DOI metadata lookup and the same bounded calculation. They do not exchange
  messages.
- **B — sequential flywheel:** a metadata verifier searches and hands off to an
  algebra reviser, which calculates and hands off to an independent final
  auditor. The auditor repeats both checks before reporting.

Both methods use the same local GPT-OSS model, supplied task, source boundary,
arithmetic expression, Compile instructions, and deterministic evaluator. The
task checks Crossref metadata for `10.1007/BF00253344` and evaluates the supplied
exercise relation `2/p + 3/q = 1` at `q = 6`. Metadata confirms bibliographic
identity only. It does not verify full text, theorem hypotheses, or global
regularity.

Run both orders so a warm model does not always benefit the same arm:

```bash
npm run experiment:research-ab
MULTICONTEXT_RESEARCH_AB_ORDER=BA npm run experiment:research-ab
```

Artifacts are written under ignored, private
`data/experiments/research-ab-<timestamp>/` directories. Each run retains the
state, model request/response trace, MCP trace, and scored result. Raw experiment
records are not release assets and must be reviewed before sharing.

## Acceptance criteria

For each relevant persona the evaluator checks:

- the required tool order;
- an exact DOI lookup with the expected metadata record;
- a real `calculate` result of `4` with `proofVerified=false`;
- an explicit report of `p = 4` and no conflicting `p` value;
- an explicit no-proof/full-text boundary;
- no affirmative claim that the Millennium problem was solved;
- expected cross-chat deliveries for B and no deliveries for A;
- a settled runtime with no member error.

Compile additionally stores a deterministic Scheduler-derived tool audit. The
model cannot replace this audit by merely claiming that it searched, calculated,
or sent a message.

## Product defects found by using the app

The experiment was intentionally allowed to fail before the harness was treated
as trustworthy.

1. Compile initially attributed a calculation to the wrong persona because only
   prose, not generic tool telemetry, was available. Per-message `toolEvidence`
   and a deterministic Compile `toolAudit` now retain member, message, call ID,
   outcome, and bounded safe facts.
2. The first evaluator treated a negative heading such as “none of this proves”
   as an affirmative proof claim. The proof boundary detector is now isolated and
   regression-tested.
3. A later run executed the correct calculation but did not explicitly report
   `p = 4`; one response also temporarily identified `p` with the denominator.
   Tool success alone was therefore an insufficient quality score. The evaluator
   now requires the reported conclusion and rejects conflicting values.
4. A generated Compile report miscounted B's searches even while its embedded
   generic audit had the right total. The deterministic audit is now stored and
   displayed independently, included in copy/download output, and no longer asks
   the model-written synthesis to repeat machine-owned counts.
5. The main interface still presented LibreChat as a standard prerequisite even
   in direct-local mode. New Node/Desktop starts now default to local, the local
   runtime hides optional LibreChat rows, and backend-specific recovery guidance
   no longer asks local users to register an Agent.

Tool evidence deliberately excludes raw peer prompts, inspected message content,
search result text, and private error detail. It is execution telemetry, not a
correctness certificate.

## Balanced observed results

The following are two stochastic runs evaluated with the final strict criteria,
not a statistical benchmark.

| Run / order | A independent parallel | B sequential flywheel |
|---|---|---|
| `research-ab-1788834622131` / AB | 4/6 required call positions; all other criteria passed; 10 model requests, 15,972 reported tokens, 18,924 ms | 6/6 call positions and all criteria passed; 10 requests, 15,560 tokens, 18,766 ms |
| `research-ab-1788834772935` / BA | 6/6 and all criteria passed; 10 requests, 16,085 tokens, 16,463 ms | 6/6 and all criteria passed; 10 requests, 16,092 tokens, 20,421 ms |

Observed totals across these two runs:

- A passed the full acceptance set in 1/2 runs; B passed in 2/2.
- A used 32,057 reported tokens; B used 31,652. The difference is too small and
  the sample too small for a cost claim.
- Timing changed with execution order. It does not support a speed claim.
- B provided explicit source-to-analysis-to-audit delivery provenance. A provided
  three independent answers and therefore remains useful when redundancy is more
  important than staged handoff.

The current product recommendation is therefore narrow: use the staged evidence
chain with an independent final auditor for provenance-sensitive research
handoffs; use independent parallel personas for redundancy. Keep measuring both
instead of permanently hard-coding one strategy from two runs.

## Additional checkpoint

### Candidate review versus flawed-peer exposure (2026-09-09 JST)

Follow-up `ns-critique-uRGNP1` used `MULTICONTEXT_NS_BLIND_FIRST=1` to save an
independent ledger before exposing the peer report. Its two calculator calls
returned 1 and 2 but did not test the requested candidate RHS. It again accepted
the false identity and called the elementary bound open. After peer exposure it
promoted the unverified continuation claim to verified without any new tool call.
Original message prefixes remained unchanged. This variant failed too.

**Confound discovered during investigation:** the configured GPT-OSS template
rendered its system message before collecting input system messages. A real Jinja
render with separate system/developer/user sentinels confirmed counts 0/1/1 in
HEAD, versus 1/1/1 after moving system rendering below collection; the repaired
role order also passed. Thus shared instructions were omitted by this template.
The source template is now fixed, but the running external llama-server must load
the updated template before fresh experiments can evaluate instruction fidelity.
Do not attribute all failures to this defect: the user/developer instructions
were present, and arithmetic errors remain observed failures. Do not use these
runs to establish method superiority without rerunning after deployment.

Deployment verification: the original 8080 server's `/apply-template` response
omitted the system sentinel. A separately launched server on 8082 loaded the
repaired template and passed `node scripts/verify-model-roles.mjs
http://127.0.0.1:8082`, checking exact marker counts, role boundaries and order.
The original external server was not restarted.

Repaired-template blind-first run `ns-critique-dwhUGd` completed both turns.
The independent response correctly rejects the candidate matrix identity using
2 versus 4, but performed only the LHS calculation and no required search; its
eigenvalue ordering and integrated-bound conclusions are still incorrect. Peer
exposure retained the matrix rejection but promoted the incorrect continuation
criterion to verified without any new tools. The original message prefix was
unchanged. This is partial numerical correction, not a passing research result.
The source-template fix is independently established; it does not explain away
model errors or certify this protocol. Saved setup/trace/results preserve both
responses for subsequent targeted intervention.

Normal-server deployment completed: all four 8080 slots were confirmed idle,
the old external process was terminated gracefully, and the same model, 65536
context and four-slot command was restarted with the corrected template.
`verify-model-roles.mjs http://127.0.0.1:8080` passed and health returned OK.

Post-deployment A/B repeat `ns-critique-TdPaJg` completed both arms. A made one
search and two unrelated calculations; it rejected the matrix candidate but
invented a 1/4 curl coefficient, supplied a non-trace-free matrix labelled
trace-free, and asserted an unsupported blowup counterexample. B made two
searches and no calculation, endorsing the false identity and erroneous
continuation criterion after exposure to the peer answer. Both fail content
acceptance. This confirms that correcting role delivery alone does not repair
the mathematical reasoning at the present model/settings. Neither this nor
the blind-first variant establishes a useful autonomous verification method;
future exploration should test smaller individually checked obligations and
source-backed interventions, retaining this negative result.

Actual local-model comparison: `data/experiments/ns-critique-pI2F7T`, produced by
`caffeinate -i node scripts/experiment-ns-critique.mjs PATH_TO_PROBE_RESULT`.
Both arms used the same candidate claims and reviewer instruction; B additionally
received the complete flawed prior answer. A ran before B with one concurrent
model request. This is one exploratory pair, not a balanced benchmark.

- A finished with one calculator call and no search. Its final verdict rejects
  the false matrix identity, but earlier prose accepts it, misorders the strain
  eigenvalues, and calls an elementary eigenvalue norm bound an open conjecture.
  Its recorded calculation `(1/3)^2+(1/3)^2+(1/3)^2` does not match the diagonal
  matrix described in its answer. Required computation/source alignment fails.
- B finished with three successful Crossref searches and no calculator call.
  It adopts the flawed report's verdicts, falsely claims numerical verification,
  and treats its own unequal values 13 and 26 as equal. Its displayed squared
  entries actually sum to 12. Metadata retrieval did not correct these errors.
- Both workspaces' member turns settled without runtime errors; neither report
  passes substantive acceptance. Source state was not changed. Setup, model
  calls/outputs, member reports, timings, and Scheduler tool evidence are saved.

This pair contradicts any blanket recommendation that giving a critic the full
prior answer improves correctness. Next compare a blind-first protocol: preserve
independent verdicts and explicit tool-backed counterexamples before exposing
peer conclusions, then request a targeted revision. Require calculation inputs
to match the matrix in the claim; tool counts alone cannot score that requirement.
No speed/cost advantage or new mathematical result follows from this pair.

### Completion audit: remaining insight-comparison requirement

First challenge execution: `ns-structure-1788854466728`, using
`MULTICONTEXT_BACKEND=local MULTICONTEXT_NS_CHALLENGE=1 node scripts/experiment-ns-structure.mjs`.
Two initial roles each issued two search calls, then their model continuations
timed out after about 905 seconds. Both remained BLOCKED with one retained queue
item; the critic was never dispatched. Six model requests, setup, state, and
failure records are preserved. There is no completed research answer or A/B score
from this run. Investigate model continuation latency before retrying the saved
work; restarting the full experiment would lose the relevant failure context.

The timeout investigation found a matching OS suspension: `pmset -g log` records
Idle Sleep at 2026-09-08 17:01:19 JST for 902 seconds, followed by DarkWake at
17:16:21. The failed requests started at 17:01:14 and 17:01:17; llama-server
logged only 230 and 114 generated tokens before cancellation after wake. All four
slots were idle on inspection. This supports sleep interruption, not evidence of
an endless model reasoning loop. Exclude this run from latency comparisons.
For macOS unattended reproduction, scope sleep prevention to the command using
`caffeinate -i node scripts/experiment-ns-structure.mjs` with the challenge/local
environment variables above; do not change global power settings. Resume the
saved failed continuation first and preserve its original timeout record.

Saved-request probe completed under `caffeinate -i` in
`ns-structure-1788854466728/continuation-probe-9z1Cto`. It copied conversation
snapshots and replayed only the two failed model calls, without dispatching tools
or changing the source workspace. Responses took 34,373 ms and 1,214 ms. The
second response requests another search and is not a completed role report.
This sequential diagnostic supports the sleep explanation but is not a completed
parallel experiment or an A/B timing comparison.

The first response is rejected: it endorses both supplied false candidates,
attributes the squared-L2-time condition to Miller, and even writes the correct
matrix decomposition before an invalid rearrangement and acceptance of the
incompatible candidate identity. A symmetric trace-free gradient diag(1,-1,0)
has squared norm 2, strain squared norm 2, and zero curl, so the candidate's RHS
is 4. The response's proposed open question about bounding the negative middle
eigenvalue by the full gradient is also already settled by the elementary
pointwise norm bound. Preserve this as an overclaiming failure for the next
independent-critic intervention; it cannot be promoted to knowledge by Compile.

Independent scoring-source check: the live arXiv version of Miller's paper
(`https://arxiv.org/html/1710.05569`, Theorem 1.1) states
`2/p + 3/q = 2`, `3/2 < q <= infinity`; thus q=2 requires p=4.
Its definitions of the symmetric and antisymmetric gradient parts also allow
an independent matrix check. These source checks were not supplied as corrected
answers to the challenge roles.

The current A/B results establish tool-use and handoff compliance on a supplied
equation. They do not establish which orchestration method discovers useful
Navier-Stokes insights more reliably. The broader research-method objective
therefore remains open even though the direct-local application checks passed.

The next comparison should use the rejected candidate retained in
`NS_STRUCTURE_REVIEW.md`: assess the claimed squared-L2-in-time middle-strain
criterion and the pointwise strain/vorticity identity. Give both arms identical
candidate statements and source access, without supplying the correction. Compare
independent parallel review against proposal, challenge, and revision with an
independent final auditor. Preserve both original answers and interventions.

Score substantive error detection, an explicit corrected condition with its
assumptions, attributable source support, unresolved analytic gaps, and unsupported
claims separately from tool counts. Check source passages independently before
using them as scoring ground truth. Run both arm orders and report all failures,
model requests, reported tokens, and elapsed time. A correct arithmetic response
alone cannot pass this insight-comparison gate. Existing native GUI and build
checks need not be repeated unless this work changes the application.

After the deterministic Compile audit was added, the saved B workspace from
`research-ab-1788832732994` was copied and compiled again with the real local
model. The new record is
`data/experiments/research-summary-1788834219965/result.json`: six attempts and
six successes, exactly two each for `search_sources`, `calculate`, and
`send_to_chat`, with all six call IDs attributed to the correct three members.
The serialized source member histories were unchanged by Compile.
