export function workspaceStatusLabel(state) {
  const map = {
    running: '実行中',
    pending: 'キューあり',
    blocked: '要対応',
    error: '要対応',
    settled: '完了',
    idle: '待機中',
  };
  const normalized = String(state || '').toLowerCase();
  const label = map[normalized] || '状態確認中';
  const cls = normalized === 'error' ? 'blocked' : normalized || 'unknown';
  return { label, cls, normalized };
}

export function memberStatusLabel(state) {
  const labels = { error: 'ブロック中', running: '実行中', idle: '待機中' };
  const normalized = String(state || '').toLowerCase();
  const label = labels[normalized] || '状態確認中';
  const cls = normalized === 'error' ? 'blocked' : normalized || 'unknown';
  return { label, cls, normalized };
}

export function workspaceStatusHtml(state, esc = (v) => String(v)) {
  const { label, cls } = workspaceStatusLabel(state);
  return `<span class="status ${esc(cls)}" title="ランタイム状態: ${esc(label)} — 生成中/キュー/ブロックの有無のみを示し、合意や完了を意味しません">${esc(label)}</span>`;
}
