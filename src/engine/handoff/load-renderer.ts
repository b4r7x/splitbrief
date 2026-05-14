import { readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { HandoffInput, HandoffPack } from './types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveFromProject } from '../../utils/path-patterns.js';

export type RendererFunction = (input: HandoffInput) => Promise<HandoffPack> | HandoffPack;

export type LoadRendererResult =
  | { ok: true; fn: RendererFunction }
  | { ok: false; reason: string };

export async function loadRenderer(
  rendererPath: string,
  projectDir: string,
): Promise<LoadRendererResult> {
  const absPath = resolveFromProject(projectDir, rendererPath);
  const url = pathToFileURL(absPath).href;
  try {
    const mod: unknown = await import(url);
    if (mod === null || typeof mod !== 'object') {
      return { ok: false, reason: 'module did not export an object' };
    }
    const fn = (mod as { default?: unknown }).default;
    if (typeof fn !== 'function') {
      return { ok: false, reason: 'module default export is not a function' };
    }
    return { ok: true, fn: fn as RendererFunction };
  } catch (err) {
    return { ok: false, reason: toErrorMessage(err) };
  }
}

export function listCustomRenderers(projectDir: string): string[] {
  const renderersDir = join(projectDir, '.diptych', 'handoff-renderers');
  if (!existsSync(renderersDir)) {
    return [];
  }
  const entries = readdirSync(renderersDir);
  return entries
    .filter(name => name.endsWith('.ts') || name.endsWith('.js'))
    .map(name => name.replace(/\.(ts|js)$/, ''));
}
