import { readFile } from 'node:fs/promises';
import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { resolveFromProject } from '../../../utils/path-patterns.js';
import { redactSecretsWithMetadata } from '../../../utils/redact.js';

export async function blockSecrets(event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  const file = 'file' in event && typeof event.file === 'string' ? event.file : null;
  if (!file) return { kind: 'allow' };
  const abs = resolveFromProject(ctx.projectDir, file);
  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    return { kind: 'allow' };
  }
  const { redacted } = redactSecretsWithMetadata(content);
  if (redacted) {
    return { kind: 'deny', message: `secret detected in ${file}` };
  }
  return { kind: 'allow' };
}
