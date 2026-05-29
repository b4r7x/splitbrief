import type { HookEvent, HooksConfig } from '../../../core/schemas/hooks.js';
import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { prettierOnChange } from './prettier-on-change.js';
import { blockSecrets } from './block-secrets.js';

export interface BuiltinHook {
  name: string;
  event: HookEvent;
  enabledByDefault: boolean;
  run: (event: EngineEvent, ctx: HookContext) => Promise<HookOutcome>;
}

export const BUILTIN_HOOKS: BuiltinHook[] = [
  {
    name: 'prettier-on-change',
    event: 'post_task',
    enabledByDefault: false,
    run: prettierOnChange,
  },
  { name: 'block-secrets', event: 'pre_commit', enabledByDefault: false, run: blockSecrets },
];

export function activeBuiltinsFor(event: HookEvent, hooks: HooksConfig | undefined): BuiltinHook[] {
  return BUILTIN_HOOKS.filter((b) => {
    if (b.event !== event) return false;
    const userOverride = hooks?.builtin?.[b.name];
    if (userOverride === true) return true;
    if (userOverride === false) return false;
    return b.enabledByDefault;
  });
}
