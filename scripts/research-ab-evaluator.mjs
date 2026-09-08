// Deterministic guards used by the stochastic research A/B harness.
// Keep these separate so an evaluator bug can be regression-tested without
// starting a model server or running the experiment.
export function hasAffirmativeProofClaim(text) {
  const source = String(text || '');
  const pattern = /\b(?:solve(?:s|d)?|prove(?:s|d)?|establish(?:es|ed)?)\b[^.\n;:]{0,80}\b(?:navier(?:[\s–—-]*stokes)?|global regularity|millennium problem)\b/gi;
  return [...source.matchAll(pattern)].some(match => {
    const before = source.slice(0, match.index);
    const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n'), before.lastIndexOf(';'), before.lastIndexOf(':'));
    const prefix = before.slice(clauseStart + 1).slice(-100).toLowerCase();
    return !/\b(?:not|no|none|neither|never|cannot|can't|doesn't|didn't|without|fails?|failed|insufficient)\b/.test(prefix);
  });
}

export function reportsExpectedP(text) {
  return /\bp\s*(?:=|:|is|equals?)\s*(?:\\?\(?\s*)?4\b/i.test(String(text || ''));
}

export function hasConflictingPClaim(text) {
  return /\bp\s*(?:=|:|is|equals?)\s*(?:\\?\(?\s*)?(?:1\s*\/\s*2|0\.5|1\b)/i.test(String(text || ''));
}

export function parseArmOrder(value = 'AB') {
  const normalized = String(value || 'AB').trim().toUpperCase();
  if (!['AB', 'BA'].includes(normalized)) throw new Error('MULTICONTEXT_RESEARCH_AB_ORDER must be AB or BA');
  return [...normalized];
}
