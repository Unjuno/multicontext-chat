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
    case 'mcp.run.started': return { ...base, action: 'run started' };
    case 'run.settled': return { ...base, action: 'run settled' };
    case 'run.blocked': return { ...base, action: 'run blocked' };
    case 'run.failed': return { ...base, action: 'run failed' };
    case 'run.cancelled': return { ...base, action: 'run cancelled' };
    case 'run.members.cancelled':
      return { ...base, action: 'run members cancelled', detail: detail.cancelled != null ? `${detail.cancelled} items` : null };
    case 'q.enqueued':
      return { ...base, action: 'queue item enqueued', detail: detail?.target?.type === 'member' ? `→ ${shortId(detail.target.memberId)}` : (detail?.target?.type || null) };
    case 'q.dispatched':
      return { ...base, action: detail?.broadcast ? 'broadcast dispatched' : 'queue item dispatched' };
    case 'member.started': return { ...base, action: 'member started' };
    case 'member.completed': return { ...base, action: 'member completed' };
    case 'member.cancelled': return { ...base, action: 'member cancelled' };
    case 'member.failed': return { ...base, action: 'member failed', detail: detail.code ? String(detail.code) : null };
    case 'tool.list_chats': return { ...base, action: 'list_chats' };
    case 'tool.inspect_chat':
      return { ...base, action: 'inspect_chat', target: detail.target ? String(detail.target) : null };
    case 'tool.send_to_chat':
      return {
        ...base,
        action: 'send_to_chat',
        target: Array.isArray(detail.targets) && detail.targets.length ? detail.targets.map(String).join(', ') : null,
      };
    case 'tool.replayed': return { ...base, action: `replayed ${detail.tool ? String(detail.tool) : 'tool'}` };
    case 'human.send': return { ...base, action: 'direct send' };
    case 'human.broadcast': return { ...base, action: 'broadcast sent' };
    case 'human.stop': return { ...base, action: 'stop' };
    case 'orchestrator.paused': return { ...base, action: 'orchestrator paused' };
    case 'orchestrator.resumed': return { ...base, action: 'orchestrator resumed' };
    case 'compile.started': return { ...base, action: 'compile started' };
    case 'compile.completed': return { ...base, action: 'compile completed' };
    case 'compile.failed': return { ...base, action: 'compile failed' };
    default:
      if (ev.type.startsWith('tool.')) return { ...base, action: ev.type };
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
