export function reviewContext(workspace, memberId) {
  const notes = (workspace.reviewNotes || []).filter(note => !memberId || note.memberId === memberId);
  return { verificationStatus: 'UNREVIEWED', reviewNotes: notes.slice(-8), omittedReviewNotes: Math.max(0, notes.length - 8) };
}

export function distilledContext(body, review) {
  const annotations = review.reviewNotes.map(({ id, memberId, messageId, verdict, rationale }) => ({
    id, memberId, messageId, verdict, rationale: rationale.slice(0, 400), rationaleTruncated: rationale.length > 400,
  }));
  const text = `UNREVIEWED excerpts, not verified findings. Reviews are self-reported assessments, not proof. Truncated or omitted evidence must be retrieved before reuse.\nREVIEW_CONTEXT ${JSON.stringify({ reviewNotes: annotations, omittedReviewNotes: review.omittedReviewNotes })}\n\n${body}`;
  return { distilled: text.slice(0, 8000), distilledTruncated: text.length > 8000 };
}

export function messageHandoff(message, limit) {
  const content = String(message.content ?? '');
  return { id: message.id ?? null, role: message.role, pending: Boolean(message.pending),
    content: content.slice(0, limit), truncated: content.length > limit,
    searchEvidence: message.searchEvidence || { scope: 'UNRECORDED' },
    toolEvidence: message.toolEvidence || { scope: 'UNRECORDED' } };
}
