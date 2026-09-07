# Orchestrator-use review

Observed friction: recovering an actionable next question from long, unreliable
peer replies was costly. Existing Compile silently cut each message at 500
characters and omitted message IDs. It also asked for THEOREM/CONFIDENCE headings,
which can suggest more verification than synthesis has performed.

Changes: snapshots now include message/member IDs, original lengths, truncation
flags, and omitted-message counts. The handoff requests CLAIMS / EVIDENCE / GAPS /
NEXT_ACTION, explicitly distinguishing claims from verification and forbidding
invented missing steps. Saved reports include an UNREVIEWED status and source
manifest. The GUI states that citations do not prove correctness. Empty responses
and pending tool calls are rejected rather than saved as completed reports.

Actual use: `scripts/smoke-research-summary.mjs` compiled a copy of the recorded
failed NS experiment using direct GPT-OSS. Output is retained in
`data/experiments/research-summary-1788821500903/`. Member histories were unchanged.
The summary included IDs and next questions, but still repeated wrong exponents
and labeled prompt text as “Observation.” Therefore this is an improvement in
traceability, NOT successful automated verification. The orchestrator must inspect
the sources and reject those claims. The arithmetic-gate sidecar was not part of
the workspace input and must not be assumed known to the summarizer.

Next product need: bring explicit operator/checker verdicts into the workspace
as attributable records, so failed claims are not repeatedly rediscovered as
plausible hypotheses. Do not solve this by automatically trusting model consensus.

Validation: Node check 320 total / 317 pass / 0 fail / 3 skip before adding the
saved manifest and GUI notice. The live summary covered the changed handoff prompt,
not the later GUI notice or manifest fields. These still need UI/integration checks.
