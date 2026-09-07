import mixed from './librechat-mixed-handler.cjs';

// Conservative source parity gate, not evidence of the running process version.
export function verifyInstalledMixedSource(source) {
  for (const helper of [mixed.createMixedOwnershipHandler, mixed.createMixedResultSerializer]) {
    if (!source.includes(helper.toString())) {
      throw new Error(`Installed LibreChat ${helper.name} is missing or stale. Reapply scripts/patch-librechat.mjs, rebuild/restart LibreChat, and repeat verification.`);
    }
  }
}
