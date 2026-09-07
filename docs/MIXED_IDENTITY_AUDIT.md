# Mixed tool request identity audit

The mixed adapter previously validated result identities against a Set of
provider call IDs, but did not validate request IDs before calling the provider
executor. Duplicate request IDs could therefore invoke tools before result
validation rejected them, or collapse distinct calls into one expected identity.
A shared ID across provider/external ownership also made result association
ambiguous. This is a robustness defect for malformed provider responses; normal
well-formed batches were not observed failing for this reason.

The adapter now rejects missing, blank, or duplicate IDs across the entire
externally deferred batch before any provider handler invocation. Provider-only
requests continue through the original LibreChat handler unchanged.

Four regression cases assert zero provider invocations, no stored output, and no
external deferral. The 12-case adapter suite passes. The installed LibreChat
executor integration also passes with two real executor invocations and zero
cross-chat invocations, preserving empty/text results and SDK formatting.

This is executor-contract evidence, **not real model mixed-batch E2E or provider
wire capture**. The patch source is updated in this repository; this incremental
fix has not yet been applied to/restarted in the running LibreChat process.

Full `npm run check` after this change: 309 total, 306 pass, 0 fail, 3 skip.

Real-model fixture prerequisite investigation: the installed LibreChat includes a
built-in `calculator` tool, a suitable no-search-key provider-owned tool. Adding it
as a request-level function would not test provider ownership: the current patch
treats request-level functions as caller-owned. It must be enabled on a dedicated
saved Agent. Agent-management routes use JWT authentication, whereas the available
Remote Responses credentials are API-key credentials. A read-only request to
`/api/agents/agent_1Uuy9PuCMMa4aUEe4R0_t/expanded` returned HTTP 401. No existing
Agent was modified and no direct database workaround was used. An authenticated
Agent-management session or a dedicated calculator-enabled Agent is needed for
this real-model fixture. This is a specific unfulfilled E2E prerequisite, not
evidence that the executor-contract test covers the model path.

Prepared real-model command (not yet executed with an eligible Agent):

```sh
node --env-file=.env scripts/smoke-research-flywheel.mjs CALCULATOR_ENABLED_AGENT_ID --calculator
```

The experiment uses a new isolated workspace and actual canonical cross-chat
delivery. It requires a recorded calculator call/result and an external call in
one aggregated response, then verifies conversation continuity and exactly one
provider result in the next ordered continuation. Existing search/DOI/reviewer
checks remain required. A model that omits calculator fails this acceptance check.
The optional mode has only received syntax/diff checks so far, not runtime proof.
Even a pass is sequential mixed evidence; it does not certify same-step mixed
generation or provider-wire parameter propagation.
