// Pure run-follow helpers for the orchestrator bar (no DOM access).
// An experiment-start focus hint carries an optional run_id. While that run
// is active the bar follows it explicitly instead of deriving "current" from
// the run list; once it reaches a terminal state the hint is dropped and the
// derived current resumes. Terminal set must match the orchestrator engine.
export const TERMINAL_RUN_STATUSES = ['settled', 'blocked', 'failed', 'cancelled'];

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || ''));
}

function derivedCurrentRun(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return list.find((r) => r && (r.status === 'running' || r.status === 'queued')) || list[0] || null;
}

// 'following': attached run is live. 'terminal': attached run finished (drop
// the hint). 'unknown': attached run not in the list yet (keep waiting —
// orchestrator state may lag run creation). 'none': no hint attached.
export function followedRunState(runs, focusedRunId) {
  if (!focusedRunId) return 'none';
  const list = Array.isArray(runs) ? runs : [];
  const found = list.find((r) => r && r.id === focusedRunId);
  if (!found) return 'unknown';
  return isTerminalRunStatus(found.status) ? 'terminal' : 'following';
}

// Returns { run, following }. `following` is true only while a live,
// explicitly-attached run exists; terminal or unknown ids fall back to the
// derived current run (unknown keeps the hint alive for a later refresh).
export function pickDisplayedRun(runs, focusedRunId) {
  const list = Array.isArray(runs) ? runs : [];
  if (followedRunState(list, focusedRunId) === 'following') {
    return { run: list.find((r) => r && r.id === focusedRunId), following: true };
  }
  return { run: derivedCurrentRun(list), following: false };
}
