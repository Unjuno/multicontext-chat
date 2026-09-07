# Bounded Navier–Stokes insight experiment

Run with `node --env-file=.env scripts/experiment-ns-insights.mjs AGENT_ID`.

This experiment asks two local-model personas to independently derive/check an
enstrophy estimate and its scaling obstruction. A third persona then audits their
reports. It uses the canonical application send operation and Scheduler, with at
most two simultaneous requests. Peer reports are explicitly labeled untrusted.
The aim is to find a checkable next mathematical question, not manufacture a claim
that the Millennium problem is solved.

Evidence is retained under ignored `data/experiments/ns-insights-TIMESTAMP/`:
state, ordered request/response trace, peer reports, and final workspace/result.
Request count and elapsed wall time are measured; token savings are not inferred.
Model completions and successful execution are not mathematical verification.
No existing user workspace is stopped or modified.

Initial launch: `ns-insights-1788815305320`, workspace
`000c2d39-4d69-4a53-a5bb-8a5adeddd4ad`. At launch two worker requests were running.
Completion and the mathematical content must be inspected in the recorded result;
this document does not certify them in advance.
