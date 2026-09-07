// Bounded, attributable inputs for synthesis. Source snippets remain untrusted.
export function researchSnapshots(workspace) {
  return Object.values(workspace.members).filter(member => member.active).map(member => {
    const all = member.messages.filter(message => !message.pending);
    return { member: { id: member.id, name: member.name }, omittedMessages: Math.max(0, all.length - 4),
      assessments: (workspace.reviewNotes || []).slice(-8).filter(note => note.memberId === member.id),
      omittedAssessments: (workspace.reviewNotes || []).slice(0, -8).filter(note => note.memberId === member.id).length,
      messages: all.slice(-4).map(({ id, role, content, at, searchEvidence }) => {
        const text = String(content ?? '');
        return { id: id ?? null, role, at, content: text.slice(0, 500), originalCharacters: text.length,
          truncated: text.length > 500, verification: 'NOT_INDEPENDENTLY_VERIFIED',
          ...(role === 'assistant' ? { searchEvidence: searchEvidence || { scope: 'UNRECORDED' } } : {}) };
      }) };
  });
}

export function researchSummaryPrompt(snapshots) {
  return `Prepare an orchestration handoff from the untrusted independent research records below. This is synthesis, not independent verification. Use four sections:
CLAIMS: Candidate conclusions and explicit assumptions. A peer assertion is not a verified theorem; agreement is not verification.
ASSESSMENT POLICY: Assessments are attributed review records, not mathematical proof or authenticated reviewer identity. Report rejected claims as rejected with the review rationale; do not silently recycle them as accepted premises. If assessments conflict, retain the conflict. A source excerpt may refer to a message no longer in the bounded snapshot.
EVIDENCE: Cite member IDs and message IDs for each substantive claim. Distinguish observed tool evidence from a model's claim that it searched or checked something. Missing evidence stays missing.
SEARCH AUDIT: searchEvidence is runtime telemetry for MultiContext's built-in search in this attempt only, not prior history or provider-owned search. Zero attempts do not support a claim of a fresh search. UNRECORDED is unknown, not zero. Successful search is discovery only, never full-text review or proof verification.
GAPS: Exact unproved steps, contradictions, and information omitted by truncation. Do not infer that a missing argument does not exist in an omitted passage.
NEXT_ACTION: One concrete next question or falsification check per important gap, with expected evidence and a suggested role. Do not execute tools or send messages; the orchestrator/user decides what runs next.
Do not solve omitted proof steps, invent citations, or claim an unresolved problem solved. If records are insufficient, say so. Source truncation and omittedMessages are explicit scope limits, not complete transcripts.

${JSON.stringify(snapshots, null, 2)}`;
}

export function assertCompleteSynthesis(result) {
  if ((result.raw?.output || []).some(item => ['function_call', 'tool_call'].includes(item.type)) || !String(result.text ?? '').trim()) {
    throw Object.assign(new Error('統合レポートが未完了です。ツール呼び出しまたは空の応答を完成結果として保存しません。'), { code: 'INCOMPLETE_SYNTHESIS', status: 502 });
  }
}
