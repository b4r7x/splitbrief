import type { HookCommandEntry, HookModuleEntry } from '../../../src/core/schemas/hooks.js';

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

export function makeThrowingModuleHook(overrides?: Partial<HookModuleEntry>): HookModuleEntry {
  return {
    kind: 'module',
    path: 'testing/fixtures/hooks/throws.mjs',
    timeout_ms: 5000,
    on_failure: 'warn',
    ...overrides,
  };
}
