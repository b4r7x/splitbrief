import { readFile } from 'node:fs/promises';
import type { EngineEvent } from '../../events/types.js';
import type { HookOutcome, HookContext } from '../types.js';
import { resolveFromProject } from '../../../utils/path-patterns.js';

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS access key',    re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub PAT',        re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'OpenAI API key',    re: /\bsk-[A-Za-z0-9]{48}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9-]{40,}\b/ },
];

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
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      return { kind: 'deny', message: `secret pattern matched (${name}) in ${file}` };
    }
  }
  return { kind: 'allow' };
}
