import { join, isAbsolute } from 'node:path';
import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { runCommand } from '../../../lib/process/spawn.js';

export async function prettierOnChange(event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  const file = 'file' in event && typeof event.file === 'string' ? event.file : null;
  if (!file) return { kind: 'allow' };
  const abs = isAbsolute(file) ? file : join(ctx.projectDir, file);
  try {
    const result = await runCommand('npx', ['prettier', '--write', abs], { cwd: ctx.projectDir, timeout: 30_000 });
    if (result.code === 0) return { kind: 'allow' };
    return { kind: 'warn', message: `prettier failed for ${file} (exit ${result.code}): ${result.stderr.trim()}` };
  } catch (err) {
    return { kind: 'warn', message: err instanceof Error ? err.message : String(err) };
  }
}
