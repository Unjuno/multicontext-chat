export function workspaceStatusLabel(state) {
  const map = {
    running: 'RUNNING · 実行中',
    pending: 'PENDING · キューあり',
    blocked: 'BLOCKED · 要対応',
    error: 'BLOCKED · 要対応',
    settled: 'SETTLED · 処理待ちなし',
    idle: 'SETTLED · 処理待ちなし',
  };
  const normalized = String(state || '').toLowerCase();
  const label = map[normalized] || String(state || '').toUpperCase() || 'UNKNOWN';
  const cls = normalized === 'error' ? 'blocked' : normalized || 'unknown';
  return { label, cls, normalized };
}

export function memberStatusLabel(state) {
  const labels = { error: 'ブロック中', running: '実行中', idle: '待機' };
  const normalized = String(state || '').toLowerCase();
  const label = labels[normalized] || String(state || '').toUpperCase() || 'UNKNOWN';
  const cls = normalized === 'error' ? 'blocked' : normalized || 'unknown';
  return { label, cls, normalized };
}

export function workspaceStatusHtml(state, esc = (v) => String(v)) {
  const { label, cls } = workspaceStatusLabel(state);
  return `<span class="status ${esc(cls)}" title="ランタイム状態: ${esc(label)} — 生成中/キュー/ブロックの有無のみを示し、合意や完了を意味しません">${esc(label)}</span>`;
}
