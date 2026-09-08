export function toolEvidenceLabel(evidence) {
  if (evidence?.scope !== 'MULTICONTEXT_TOOLS_THIS_ATTEMPT') return 'ツール実行記録なし（旧履歴・未記録を含む）';
  const requirement = evidence.requirements;
  const missing = requirement?.status === 'NEEDS_CHECK'
    ? `要確認: 必須ツール不足（${Object.entries(requirement.missing || {}).map(([name, count]) => `${name}×${Number(count)}`).join('、') || '詳細不明'}）。`
    : '';
  if (evidence.attempted === 0) return `${missing}今回の処理: MultiContext外部ツールの実行なし`;
  const counts = new Map();
  for (const call of evidence.calls || []) counts.set(call.tool, (counts.get(call.tool) || 0) + 1);
  const names = [...counts].map(([name, count]) => `${name}×${count}`).join('、') || '詳細省略';
  const omitted = evidence.omittedCalls ? `、ほか${Number(evidence.omittedCalls)}件` : '';
  return `${missing}今回の外部ツール: ${names}${omitted} — 成功 ${Number(evidence.succeeded) || 0} / 失敗 ${Number(evidence.failed) || 0} / 再利用 ${Number(evidence.replayed) || 0}。実行記録であり、内容の正しさや証明を保証しません`;
}

export function compileToolAuditLabel(audit) {
  if (audit?.scope !== 'COMPILE_SNAPSHOT_SCHEDULER_TOOL_AUDIT') return '確定ツール集計なし（旧レポート）';
  const entries = Object.entries(audit.byTool || {});
  const tools = entries.map(([name, counts]) => `${name}×${Number(counts?.attempted) || 0}`).join('、') || '実行なし';
  const totals = audit.totals || {};
  const coverage = audit.coverage || {};
  const incomplete = Number(coverage.sourceOmittedCalls) > 0 || Number(coverage.unrecordedAssistantMessages) > 0;
  const scope = incomplete
    ? `保存範囲のみ（省略 ${Number(coverage.sourceOmittedCalls) || 0}件 / 未記録メッセージ ${Number(coverage.unrecordedAssistantMessages) || 0}件）`
    : 'スナップショット内の全記録';
  return `MultiContext確定ツール集計: ${tools} — 実行 ${Number(totals.attempted) || 0} / 成功 ${Number(totals.succeeded) || 0} / 失敗 ${Number(totals.failed) || 0} / 再利用 ${Number(totals.replayed) || 0}（${scope}）。実行記録であり、内容の正しさや証明を保証しません`;
}

export function compileRecordMarkdown(compile, fallbackText = '') {
  const text = String(compile?.text ?? fallbackText ?? '');
  if (compile?.toolAudit?.scope !== 'COMPILE_SNAPSHOT_SCHEDULER_TOOL_AUDIT') return text;
  const json = JSON.stringify(compile.toolAudit, null, 2).replaceAll('`', '\\u0060');
  return `## MultiContext確定ツール集計\n\n${compileToolAuditLabel(compile.toolAudit)}\n\n\`\`\`json\n${json}\n\`\`\`\n\n## モデルによる統合\n\n${text}`;
}
