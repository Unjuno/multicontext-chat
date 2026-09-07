# Navier–Stokes knowledge-flywheel protocol

This is an experiment protocol for testing MultiContext's research workflow. It is not a claim that the Millennium problem has been solved.

## Persona lanes

1. Harmonic Analyst: state hypotheses and the exact functional-analytic estimate.
2. Numerical Skeptic: test whether finite-dimensional or numerical evidence supports the claim, without treating it as a proof.
3. Blow-up Hunter: search for self-similar, near-singular, or concentration scenarios and identify the obstruction.
4. Proof Auditor: classify every statement as theorem, reduction, heuristic, or open step.

## Bounded flywheel

Each member must produce exactly three labeled items:

- `THEOREM`: a known result with hypotheses.
- `GAP`: the precise step that is not established.
- `CHECK`: a falsification or sanity test.

Peer inspection is optional and limited to one call per member. Recursive delegation and repeated broadcasts are not allowed. A synthesis is permitted only after the workspace is confirmed `SETTLED`.

## Confidence rubric

- High: the statement includes hypotheses and is independently checkable against a cited theorem.
- Medium: the mechanism is plausible but a hypothesis or reduction is incomplete.
- Low: the statement is heuristic, numerical-only, or depends on an unproved regularity estimate.

The final Compile must preserve these labels, list disagreements, and never turn a heuristic into a theorem. A run that remains queued or BLOCKED is evidence about orchestration behavior, not mathematical progress.

