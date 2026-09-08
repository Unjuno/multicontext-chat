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

After the deterministic Compile audit was added, the saved B workspace from
`research-ab-1788832732994` was copied and compiled again with the real local
model. The new record is
`data/experiments/research-summary-1788834219965/result.json`: six attempts and
six successes, exactly two each for `search_sources`, `calculate`, and
`send_to_chat`, with all six call IDs attributed to the correct three members.
The serialized source member histories were unchanged by Compile.
