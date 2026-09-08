// Scheduler-observed MultiContext-owned tool facts. Raw peer prompts, inspected
// messages, and search result text are deliberately not copied into this record.
export function createToolEvidence() {
  return { scope: 'MULTICONTEXT_TOOLS_THIS_ATTEMPT', attempted: 0, succeeded: 0,
    failed: 0, replayed: 0, calls: [], omittedCalls: 0 };
}

const bounded = (value, limit) => String(value ?? '').slice(0, limit);
const argsOf = call => {
  const raw = call?.args ?? call?.arguments ?? call?.function?.arguments ?? {};
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};
const outputOf = result => {
  try { return JSON.parse(result?.output); } catch { return null; }
};
const safeScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;

export function recordToolEvidence(evidence, calls, results) {
  for (const result of results) {
    const call = calls.find(candidate => candidate.call_id === result.call_id);
    if (!call) continue;
    const tool = bounded(call.name || call.function?.name || 'unknown', 80);
    const args = argsOf(call);
    const output = outputOf(result);
    const replayed = output?.replayed === true;
    const failed = output?.ok === false;
    const status = failed ? 'failed' : replayed ? 'replayed' : 'succeeded';
    evidence.attempted += 1;
    evidence[status] += 1;
    const record = { callId: bounded(result.call_id, 160), tool, status };
    if (failed) record.errorCode = bounded(output?.error?.code || 'TOOL_ERROR', 80);
    if (tool === 'calculate') {
      record.calculation = {
        expression: bounded(output?.expression ?? args.expression, 256),
        value: safeScalar(output?.value),
        arithmetic: bounded(output?.arithmetic, 80),
        proofVerified: false,
      };
    } else if (tool === 'search_sources') {
      record.search = {
        source: bounded(output?.source, 80), queryMode: bounded(output?.queryMode, 40),
        requestedDoi: bounded(output?.requestedDoi, 300), lookupStatus: bounded(output?.lookupStatus, 80),
        resultCount: Array.isArray(output?.results) ? output.results.length : 0,
        evidenceType: bounded(output?.evidenceType, 80), fullTextVerified: false,
      };
    } else if (tool === 'send_to_chat') {
      const deliveries = Array.isArray(output?.deliveries) ? output.deliveries : [];
      record.delivery = { count: deliveries.length, targets: deliveries.slice(0, 2).map(item =>
        bounded(item?.target?.name || item?.target?.id || item?.targetId, 120)).filter(Boolean) };
    } else if (tool === 'list_chats') {
      record.list = { count: Array.isArray(output?.chats) ? output.chats.length : 0 };
    } else if (tool === 'inspect_chat') {
      record.inspection = { target: bounded(args.target ?? args.chat_id, 120),
        resultCount: Array.isArray(output?.messages) ? output.messages.length : Array.isArray(output?.results) ? output.results.length : 0 };
    }
    if (evidence.calls.length < 8) evidence.calls.push(record);
    else evidence.omittedCalls += 1;
  }
}
