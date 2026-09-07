// Task-specific arithmetic checks, NOT a PDE proof checker.
export function checkExponentReport(kind, content) {
  const expected = kind === 'scaling'
    ? { kinetic: -1, enstrophy: 1, palinstrophy: 3, stretching: 3 }
    : kind === 'interpolation'
      ? { theta: 0.75, enstrophyPower: 0.75, palinstrophyPower: 0.75, youngP: 4 / 3, youngQ: 4, viscosityPower: -3, finalEnstrophyPower: 3 }
      : null;
  if (!expected) throw new Error('Unknown exponent task');
  let actual;
  try { actual = JSON.parse(content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { return { passed: false, reason: 'INVALID_JSON', scope: 'NUMERIC_EXPONENTS_ONLY' }; }
  const failures = Object.entries(expected).filter(([key, value]) =>
    typeof actual?.[key] !== 'number' || !Number.isFinite(actual[key]) || Math.abs(actual[key] - value) > 1e-9)
    .map(([key]) => key);
  return { passed: failures.length === 0, failures, scope: 'NUMERIC_EXPONENTS_ONLY', actual };
}
