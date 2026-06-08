import { readFile } from 'node:fs/promises';
import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { resolveFromProject } from '../../../utils/path-patterns.js';
import { redactSecretsWithMetadata } from '../../../utils/redact.js';

function filesToScan(event: EngineEvent, ctx: HookContext): string[] {
  if (ctx.files && ctx.files.length > 0) return ctx.files;
  const file = 'file' in event && typeof event.file === 'string' ? event.file : null;
  return file ? [file] : [];
}

export async function blockSecrets(event: EngineEvent, ctx: HookContext): Promise<HookOutcome> {
  for (const file of filesToScan(event, ctx)) {
    const abs = resolveFromProject(ctx.projectDir, file);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const { redacted } = redactSecretsWithMetadata(content);
    if (redacted) {
      return { kind: 'deny', message: `secret detected in ${file}` };
    }
  }
  return { kind: 'allow' };
}
