// Pure activity-feed helpers (no DOM access).
// Renders compact mechanical rows SOLELY from orchestrator events already
// persisted in server state. No semantic interpretation, no invented text:
// every row traces to a real stored event.
function shortId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

function timeOf(ev) {
  const ts = String(ev?.ts || '');
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

function memberLabel(memberId, memberNames) {
  if (!memberId) return null;
  if (memberNames && memberNames[memberId]) return String(memberNames[memberId]);
  return shortId(memberId);
}

// Returns { time, actor, action, target, detail, runId, origin } or null when
// the event type carries no observer-meaningful activity.
export function formatActivityEvent(ev, memberNames = {}) {
  if (!ev || typeof ev.type !== 'string') return null;
  const detail = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const actor = memberLabel(ev.memberId, memberNames) || (ev.actor ? String(ev.actor) : null);
  const runId = ev.runId ? shortId(ev.runId) : (detail.runId ? shortId(detail.runId) : null);
  const base = { time: timeOf(ev), actor, target: null, detail: null, runId, origin: ev.origin || null };
  switch (ev.type) {
    case 'mcp.run.started': return { ...base, action: '実行を開始' };
    case 'run.settled': return { ...base, action: '実行が完了' };
    case 'run.blocked': return { ...base, action: '実行がブロック' };
    case 'run.failed': return { ...base, action: '実行に失敗' };
    case 'run.cancelled': return { ...base, action: '実行をキャンセル' };
    case 'run.members.cancelled':
      return { ...base, action: 'メンバーの実行をキャンセル', detail: detail.cancelled != null ? `${detail.cancelled}件` : null };
    case 'q.enqueued':
      return { ...base, action: 'キューへ追加', detail: detail?.target?.type === 'member' ? `→ ${shortId(detail.target.memberId)}` : (detail?.target?.type || null) };
    case 'q.dispatched':
      return { ...base, action: detail?.broadcast ? 'ブロードキャストを配信' : 'キューを配信' };
    case 'member.started': return { ...base, action: 'メンバーの実行を開始' };
    case 'member.completed': return { ...base, action: 'メンバーの実行が完了' };
    case 'member.cancelled': return { ...base, action: 'メンバーをキャンセル' };
    case 'member.failed': return { ...base, action: 'メンバーの実行に失敗', detail: detail.code ? String(detail.code) : null };
    case 'tool.list_chats': return { ...base, action: 'チャット一覧を取得' };
    case 'tool.inspect_chat':
      return { ...base, action: 'チャットを確認', target: detail.target ? String(detail.target) : null };
    case 'tool.send_to_chat':
      return {
        ...base,
        action: 'チャットへ送信',
        target: Array.isArray(detail.targets) && detail.targets.length ? detail.targets.map(String).join(', ') : null,
      };
    case 'tool.replayed': return { ...base, action: `${detail.tool ? String(detail.tool) : 'ツール'}を再生` };
    case 'human.send': return { ...base, action: '直接送信' };
    case 'human.broadcast': return { ...base, action: 'ブロードキャスト送信' };
    case 'human.retry': return { ...base, action: '再試行を開始' };
    case 'human.stop': return { ...base, action: '停止' };
    case 'orchestrator.paused': return { ...base, action: 'オーケストレーターを一時停止' };
    case 'orchestrator.resumed': return { ...base, action: 'オーケストレーターを再開' };
    case 'compile.started': return { ...base, action: 'Compileを開始' };
    case 'compile.completed': return { ...base, action: 'Compileが完了' };
    case 'compile.failed': return { ...base, action: 'Compileに失敗' };
    default:
      if (ev.type.startsWith('tool.')) return { ...base, action: 'ツールを実行' };
      return null;
  }
}

// Newest-first renderable rows, bounded. Pure.
export function selectActivityEvents(events, { limit = 30, memberNames = {} } = {}) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  for (let i = list.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const row = formatActivityEvent(list[i], memberNames);
    if (row) rows.push(row);
  }
  return rows;
}
