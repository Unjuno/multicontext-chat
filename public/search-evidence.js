export function searchEvidenceLabel(evidence) {
  if (evidence?.scope !== 'MULTICONTEXT_SEARCH_THIS_ATTEMPT') return '検索実行記録なし（旧履歴・未記録を含む）';
  if (evidence.attempted === 0) return '今回の処理: 組み込み検索の実行記録なし（過去履歴・外部検索は対象外）';
  return `今回の組み込み検索: 結果あり ${Number(evidence.succeeded) || 0}回 / 空 ${Number(evidence.empty) || 0}回 / 失敗 ${Number(evidence.failed) || 0}回 — 本文・主張の検証ではありません`;
}
