# Built-in source search

Native agents receive `search_sources` automatically. No additional npm
packages, API key, browser automation or separately managed search server is
required. The existing native LibreChat patch is still required for external
tool execution. Compat mode does not provide this native tool.

- `source: "web"` (default): DuckDuckGo HTML results with title, URL and snippet.
- `source: "papers"`: Crossref scholarly metadata with DOI, title, authors,
  publication and year where supplied. This is not full text.

Example: `{"query":"Navier Stokes regularity","source":"papers","limit":3}`.
Ask one member to discover sources and another to check whether each claim is
supported by the returned evidence. Send exact URLs/DOIs and uncertainty with
`send_to_chat`; do not send only an unsupported summary. Search alone does not
establish a theorem or solve the Millennium problem.

Only the query is sent as a query parameter to the selected fixed search host;
no API key, workspace history or peer messages are attached. Queries still
leave the local computer. Set `MULTICONTEXT_SEARCH_ENABLED=false` in the
MultiContext server environment to disable both advertisement and execution,
then restart the server. External results must be treated as untrusted data.

The process serializes searches, spaces request starts at least 1.1 seconds
apart, and caches identical queries for ten minutes (at most 100 entries).
Each request has a 15-second timeout, a 1 MB response cap and at most five
results. A pending queue is capped at 32. Aborted queued searches make no new
request. Rate limits, unavailable services, CAPTCHA and unrecognized HTML
produce explicit errors; there is no CAPTCHA bypass, proxy rotation or silent
fallback from general web search to papers. Keyless does not mean guaranteed
availability or offline operation. DuckDuckGo HTML is a human-facing interface
and can change; Crossref provides a documented public API.

Search results include source, retrieval time, cache status and evidence type.
The activity feed records actual search execution or failure. Native tool
continuation and completed-tool persistence retain the returned result, subject
to the deployed LibreChat patch. Never infer search success from model text.

## Verification

`node --test test/research-search.test.js` uses offline response fixtures.
For a real local-model probe (creates a new LibreChat conversation and retains
evidence in a printed temporary directory):

```sh
node --env-file=.env scripts/smoke-builtin-search.mjs YOUR_AGENT_ID
```

The probe checks actual tool invocation and returned results, not factual
correctness of the final prose. See `NS_AUDIT_EXPERIMENT.md` for observations.

Official interfaces: [DuckDuckGo HTML/Lite](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript),
[Crossref public access](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/).
