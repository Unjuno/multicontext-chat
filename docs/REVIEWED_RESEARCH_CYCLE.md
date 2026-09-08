# Reviewed local research cycle — 2026-09-08

## Purpose and scope

Test whether an orchestrator can reuse an attributable rejection from a real
Navier–Stokes exploration, ask local GPT-OSS to revise it, obtain a peer audit,
and intervene on missing tool evidence. This is a bounded component of the
research workflow, not a solution of the Millennium problem or a new theorem.
No LibreChat account or API key was used. This task deliberately requests no
new search: it checks algebra conditional on a previously supplied equation,
not literature validity. Earlier real source-search evidence is separate.

## Reproduction and retained evidence

Run explicitly against a loaded local model; this is not part of `npm test`:

```bash
node scripts/smoke-reviewed-research-cycle.mjs data/experiments/ns-structure-1788822328816/state.json
```

The script copies the source state, uses the actual HTTP MCP transport for
extraction, workspace creation, persona creation, send, and readback, and saves
MCP records, model inputs/outputs, and results in an isolated experiment directory.
Assertions distinguish actual calculator outputs from a model merely writing 4.
Model compliance is nondeterministic: a failing assertion is a retained negative
result, not permission to label the run successful or silently rerun it.

Observed directory: `data/experiments/reviewed-cycle-1788831070471/`.
Input state: `data/experiments/ns-structure-1788822328816/state.json`.
An earlier harness attempt (`reviewed-cycle-1788831048617`) failed before model
dispatch because the script did not unwrap MCP's `{ member, workspace }`
add-chat response. The script was corrected; that was not an application bug.

## Initial run: partial success, acceptance failure

- MCP distillation retained `UNREVIEWED` and the full rejection rationale for
  review `b3a6787d-c15e-4ab7-a096-176ef9527a55`, concerning original message
  `19bf3e10-0986-4b0d-941d-9194dc8e9879`.
- The reviser corrected p=2 to p=4 conditional on `2/p + 3/q = 2` at q=2.
  It sent one real cross-chat message containing both source/review IDs and
  an unresolved assumption. The auditor received it in its own context.
- The reviser **did not call calculate**, despite the explicit instruction.
  Its numerically correct prose is not tool execution evidence.
- The auditor did call calculate for `2/(2-3/2)`, receiving real value 4 with
  `proofVerified: false`. It distinguished the algebra from missing analytic
  bounds and unverified literature. Its discussion of velocity-space criteria
  should not be treated as verification of the strain-eigenvalue criterion.
- Both members finished, queues settled, and the source file and copied original
  workspace were unchanged. Four model requests were recorded. The strict
  two-calculator-call acceptance **failed** and `failure.json` was retained.

## One targeted intervention: missing execution recovered

Reopened the same isolated state and local conversation snapshots, then sent
one MCP prompt to the reviser identifying the missing tool call. The prompt
explicitly superseded the earlier instruction to finish, requested calculate,
and prohibited another peer delivery or search. It did not rerun the whole task.

- Two additional real model requests: calculate call, then final answer.
- Actual result was 4, with `proofVerified: false`.
- Final response acknowledged: “I omitted the required tool call in my earlier
  reply.” It reported the calculator result.
- Prior messages were byte-equivalent under JSON serialization of their saved
  prefix; the follow-up appended messages. The workspace was SETTLED afterward.
- Evidence: `intervention-send.json`, `intervention-trace.json`, and
  `intervention-result.json`. The initial failure was not overwritten.

## Product assessment

The application supports an attributable correction loop and targeted MCP
intervention using a real local model. It does not enforce arbitrary persona
instructions as tool policies. An orchestrator must inspect tool records before
claiming a required computation or search happened. The intervention improves
the observed record; it does not retroactively turn the initial run into a pass.
This is useful for exploration with oversight, not autonomous proof certification.
Six model requests across the initial run and intervention do not establish
cost savings versus another workflow; no comparative benchmark was run.

Automated application check at this turn: 349 total, 346 passed, 0 failed,
3 skipped (declared GUI-only Stop policy). No production code changed in this
experiment. Native review-note entry/readback evidence is documented separately
in `DESKTOP_RESEARCH_AUDIT.md`.
