// Scheduler-observed facts only. Never infer search from an assistant's prose.
export function createSearchEvidence() {
  return { scope: 'MULTICONTEXT_SEARCH_THIS_ATTEMPT', attempted: 0, succeeded: 0, empty: 0, failed: 0,
    fullTextVerified: false, calls: [], omittedCalls: 0 };
}

export function recordSearchEvidence(evidence, calls, results) {
  for (const result of results) {
    const call = calls.find(c => c.call_id === result.call_id);
    if ((call?.name || call?.function?.name) !== 'search_sources') continue;
    let output;
    try { output = JSON.parse(result.output); } catch { output = null; }
    const valid = output?.ok === true && Array.isArray(output.results);
    const count = valid ? output.results.length : 0;
    const status = !valid ? 'failed' : count ? 'succeeded' : 'empty';
    evidence.attempted += 1;
    evidence[status] += 1;
    const record = { callId: String(result.call_id).slice(0, 160), status, resultCount: count,
      source: String(output?.source || '').slice(0, 80),
      evidenceType: String(output?.evidenceType || '').slice(0, 80), fullTextVerified: false };
    if (evidence.calls.length < 8) evidence.calls.push(record);
    else evidence.omittedCalls += 1;
  }
}
