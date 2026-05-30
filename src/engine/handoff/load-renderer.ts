import { readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { HandoffPack, HandoffRendererInput } from './types.js';
import { HandoffPackSchema } from './types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveFromProject } from '../../utils/path-patterns.js';
import { isRecord } from '../../utils/type-guards.js';
import { DIPTYCH_DIR } from '../../core/paths.js';

export type RendererFunction = (input: HandoffRendererInput) => Promise<HandoffPack> | HandoffPack;

export type LoadRendererResult = { ok: true; fn: RendererFunction } | { ok: false; reason: string };

type RendererCandidate = (input: HandoffRendererInput) => Promise<unknown> | unknown;

function isRendererCandidate(value: unknown): value is RendererCandidate {
  return typeof value === 'function';
}

export async function loadRenderer(
  rendererPath: string,
  projectDir: string,
): Promise<LoadRendererResult> {
  const absPath = resolveFromProject(projectDir, rendererPath);
  const url = pathToFileURL(absPath).href;
  try {
    const mod: unknown = await import(url);
    if (!isRecord(mod)) {
      return { ok: false, reason: 'module did not export an object' };
    }
    const fn = mod.default;
    if (!isRendererCandidate(fn)) {
      return { ok: false, reason: 'module default export is not a function' };
    }
    return {
      ok: true,
      fn: async (input) => {
        const rendered = await Promise.resolve(fn(input));
        return HandoffPackSchema.parse(rendered);
      },
    };
  } catch (err) {
    return { ok: false, reason: toErrorMessage(err) };
  }
}

export function listCustomRenderers(projectDir: string): string[] {
  const renderersDir = join(projectDir, DIPTYCH_DIR, 'handoff-renderers');
  if (!existsSync(renderersDir)) {
    return [];
  }
  const entries = readdirSync(renderersDir);
  return entries
    .filter((name) => name.endsWith('.ts') || name.endsWith('.js'))
    .map((name) => name.replace(/\.(ts|js)$/, ''));
}
