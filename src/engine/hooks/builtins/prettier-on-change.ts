import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { resolveFromProject } from '../../../utils/path-patterns.js';

export async function prettierOnChange(event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  const file = 'file' in event && typeof event.file === 'string' ? event.file : null;
  if (!file) return { kind: 'allow' };
  const abs = resolveFromProject(ctx.projectDir, file);
  try {
    await runCommand('npx', ['prettier', '--write', abs], {
      cwd: ctx.projectDir,
      timeout: 30_000,
    });
    return { kind: 'allow' };
  } catch (err) {
    return { kind: 'warn', message: toErrorMessage(err) };
  }
}
