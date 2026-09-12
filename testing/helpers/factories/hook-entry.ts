import type { HookCommandEntry } from '../../../src/core/schemas/hooks.js';

export function makeCommandHookEntry(overrides?: Partial<HookCommandEntry>): HookCommandEntry {
  return {
    kind: 'command',
    command: 'true',
    args: [],
    timeout_ms: 5000,
    on_failure: 'warn',
    ...overrides,
  };
}

export function makeAllowHook(name?: string): HookCommandEntry {
  return makeCommandHookEntry({ command: 'echo', args: ['ok'], ...(name ? { name } : {}) });
}
