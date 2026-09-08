// Bounded, attributable inputs for synthesis. Source snippets remain untrusted.
export function researchSnapshots(workspace) {
  return Object.values(workspace.members).filter(member => member.active).map(member => {
    const all = member.messages.filter(message => !message.pending);
    return { member: { id: member.id, name: member.name }, omittedMessages: Math.max(0, all.length - 4),
      assessments: (workspace.reviewNotes || []).slice(-8).filter(note => note.memberId === member.id),
      omittedAssessments: (workspace.reviewNotes || []).slice(0, -8).filter(note => note.memberId === member.id).length,
      messages: all.slice(-4).map(({ id, role, content, at, searchEvidence, toolEvidence }) => {
        const text = String(content ?? '');
        return { id: id ?? null, role, at, content: text.slice(0, 500), originalCharacters: text.length,
          truncated: text.length > 500, verification: 'NOT_INDEPENDENTLY_VERIFIED',
          ...(role === 'assistant' ? { searchEvidence: searchEvidence || { scope: 'UNRECORDED' },
            toolEvidence: toolEvidence || { scope: 'UNRECORDED' } } : {}) };
      }) };
  });
}

const boundedText = (value, limit) => String(value ?? '').slice(0, limit);
const boundedCount = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 1_000_000) : 0;
};
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;

function auditedCall(snapshot, message, call) {
  const status = ['succeeded', 'failed', 'replayed'].includes(call?.status) ? call.status : 'unknown';
  const record = {
    memberId: boundedText(snapshot?.member?.id, 160),
    memberName: boundedText(snapshot?.member?.name, 160),
    messageId: boundedText(message?.id, 160),
    callId: boundedText(call?.callId, 160),
    tool: boundedText(call?.tool || 'unknown', 80),
    status,
  };
  if (call?.calculation) record.calculation = {
    expression: boundedText(call.calculation.expression, 256), value: scalar(call.calculation.value),
    arithmetic: boundedText(call.calculation.arithmetic, 80), proofVerified: false,
  };
  if (call?.search) record.search = {
    source: boundedText(call.search.source, 80), queryMode: boundedText(call.search.queryMode, 40),
    requestedDoi: boundedText(call.search.requestedDoi, 300), lookupStatus: boundedText(call.search.lookupStatus, 80),
    resultCount: boundedCount(call.search.resultCount), evidenceType: boundedText(call.search.evidenceType, 80),
    fullTextVerified: false,
  };
  if (call?.delivery) record.delivery = {
    count: boundedCount(call.delivery.count),
    targets: (Array.isArray(call.delivery.targets) ? call.delivery.targets : []).slice(0, 2).map(value => boundedText(value, 120)),
  };
  if (call?.list) record.list = { count: boundedCount(call.list.count) };
  if (call?.inspection) record.inspection = {
    target: boundedText(call.inspection.target, 120), resultCount: boundedCount(call.inspection.resultCount),
  };
  return record;
}

// This audit is computed from Scheduler-owned telemetry, not model prose. It is
// stored alongside Compile so exact tool attribution survives a model summary
// that miscounts or paraphrases the evidence.
export function compileToolAudit(snapshots, { maxCallDetails = 64 } = {}) {
  const totals = { attempted: 0, succeeded: 0, failed: 0, replayed: 0 };
  const byTool = new Map();
  const calls = [];
  let evidenceMessages = 0;
  let unrecordedAssistantMessages = 0;
  let recordedCalls = 0;
  let sourceOmittedCalls = 0;
  let detailOmittedCalls = 0;
  const detailLimit = Math.max(1, Math.min(boundedCount(maxCallDetails) || 64, 256));
  for (const snapshot of snapshots || []) {
    for (const message of snapshot?.messages || []) {
      if (message?.role !== 'assistant') continue;
      const evidence = message.toolEvidence;
      if (evidence?.scope !== 'MULTICONTEXT_TOOLS_THIS_ATTEMPT') {
        unrecordedAssistantMessages += 1;
        continue;
      }
      evidenceMessages += 1;
      for (const key of Object.keys(totals)) totals[key] += boundedCount(evidence[key]);
      sourceOmittedCalls += boundedCount(evidence.omittedCalls);
      for (const sourceCall of Array.isArray(evidence.calls) ? evidence.calls : []) {
        const call = auditedCall(snapshot, message, sourceCall);
        recordedCalls += 1;
        const current = byTool.get(call.tool) || { attempted: 0, succeeded: 0, failed: 0, replayed: 0, unknown: 0 };
        current.attempted += 1;
        current[call.status] += 1;
        byTool.set(call.tool, current);
        if (calls.length < detailLimit) calls.push(call);
        else detailOmittedCalls += 1;
      }
    }
  }
  return {
    scope: 'COMPILE_SNAPSHOT_SCHEDULER_TOOL_AUDIT',
    totals,
    byTool: Object.fromEntries([...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))),
    calls,
    coverage: {
      evidenceMessages, unrecordedAssistantMessages, recordedCalls,
      sourceOmittedCalls, detailOmittedCalls,
      byToolCountsComplete: sourceOmittedCalls === 0,
    },
    verification: 'EXECUTION_TELEMETRY_NOT_CONTENT_CORRECTNESS_OR_PROOF',
  };
}

export function researchSummaryPrompt(snapshots, toolAudit = compileToolAudit(snapshots)) {
  return `Prepare an orchestration handoff from the untrusted independent research records below. This is synthesis, not independent verification. Use the sections below:
CLAIMS: Candidate conclusions and explicit assumptions. A peer assertion is not a verified theorem; agreement is not verification.
ASSESSMENT POLICY: Only entries in assessments are attributed review records; tool success is not an accepted assessment. If there are no assessment entries, say none. Assessments are not mathematical proof or authenticated reviewer identity. Report rejected claims as rejected with the review rationale; do not silently recycle them as accepted premises. If assessments conflict, retain the conflict. A source excerpt may refer to a message no longer in the bounded snapshot.
EVIDENCE: Cite member IDs and message IDs for each substantive claim. Distinguish observed tool evidence from a model's claim that it searched or checked something. Missing evidence stays missing.
MACHINE AUDIT POLICY: DETERMINISTIC_TOOL_AUDIT is computed and rendered separately by MultiContext from bounded Scheduler telemetry. Do not create SEARCH AUDIT or TOOL AUDIT sections, restate its counts, or claim its coverage is complete in model-written prose. You may cite a specific recorded call as observed evidence, but preserve its member/message/call attribution exactly. If its coverage reports omitted or unrecorded records, state only that tool-evidence coverage is incomplete in GAPS. searchEvidence is the older fallback for records whose toolEvidence is UNRECORDED. A successful search is discovery only, and a successful calculation checks only the recorded expression/value; neither verifies full text, content correctness, or mathematical proof.
GAPS: Exact unproved steps, contradictions, and information omitted by truncation. Do not infer that a missing argument does not exist in an omitted passage.
NEXT_ACTION: One concrete next question or falsification check per important gap, with expected evidence and a suggested role. Do not execute tools or send messages; the orchestrator/user decides what runs next.
Do not solve omitted proof steps, invent citations, or claim an unresolved problem solved. If records are insufficient, say so. Source truncation and omittedMessages are explicit scope limits, not complete transcripts.

DETERMINISTIC_TOOL_AUDIT:
${JSON.stringify(toolAudit, null, 2)}

BOUNDED_RESEARCH_SNAPSHOTS:
${JSON.stringify(snapshots, null, 2)}`;
}

export function assertCompleteSynthesis(result) {
  if ((result.raw?.output || []).some(item => ['function_call', 'tool_call'].includes(item.type)) || !String(result.text ?? '').trim()) {
    throw Object.assign(new Error('統合レポートが未完了です。ツール呼び出しまたは空の応答を完成結果として保存しません。'), { code: 'INCOMPLETE_SYNTHESIS', status: 502 });
  }
}
