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
