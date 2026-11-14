import { estimateTokens } from '../../../core/tokens/estimate.js';
import type { ProjectContext } from '../context.js';
import { sourceBlock } from './sources.js';
import type { ApiContextEntryState, ApiContextManifestEntry } from './types.js';

/** Why a state other than `included` appears in the packet's own footer. */
const OMISSION_REASON: Record<
  Exclude<ApiContextEntryState, 'included'>,
  (entry: ApiContextManifestEntry) => string
> = {
  excerpt: (entry) => `lines ${entry.startLine}-${entry.endLine} only`,
  missing: () => 'not present in the project',
  unsupported: () => 'not readable as text',
  omitted: () => "not supplied, outside this call's context allocation",
};

const NO_TOOLS_NOTICE =
  'Every file SPLITBRIEF read for this call is reproduced below. You have no filesystem, shell or search tool on this call: a path that is not below was not read, and nothing about its contents may be assumed or claimed.';

export type Section = { name: string; text: string; tokens: number };

export function section(name: string, text: string, model: string | undefined): Section {
  return { name, text, tokens: estimateTokens(text, model) };
}

function notSuppliedLines(
  manifest: readonly ApiContextManifestEntry[],
  project: ProjectContext,
): string[] {
  const lines: string[] = [];
  for (const entry of manifest) {
    if (entry.state === 'included') continue;
    lines.push(`- ${entry.path} — ${OMISSION_REASON[entry.state](entry)}`);
  }
  for (const note of project.notes) {
    lines.push(
      note.kind === 'readme-truncated'
        ? `- ${note.path} — first ${note.includedLines} of ${note.totalLines} lines`
        : `- src/ listing — truncated at ${note.entries} entries`,
    );
  }
  return lines;
}

export function composeText(
  project: ProjectContext,
  blocks: readonly string[],
  manifest: readonly ApiContextManifestEntry[],
): string {
  const parts: string[] = [];
  if (project.markdown !== '') parts.push(project.markdown);
  parts.push('\n## Supplied source');
  parts.push(NO_TOOLS_NOTICE);
  if (blocks.length > 0) parts.push(blocks.join('\n\n'));
  const notSupplied = notSuppliedLines(manifest, project);
  if (notSupplied.length > 0) {
    parts.push('\n### Not supplied');
    parts.push(notSupplied.join('\n'));
  }
  return parts.join('\n');
}

/**
 * The sections that do not fit, in assembly order: everything from the first one
 * that pushes the total past the allocation. Required material is never cut down
 * to be admitted — it is named as not fitting.
 */
export function overflowingSections(
  sections: readonly Section[],
  availableTokens: number,
): string[] {
  const names: string[] = [];
  let used = 0;
  for (const part of sections) {
    if (names.length === 0 && used + part.tokens <= availableTokens) {
      used += part.tokens;
      continue;
    }
    if (!names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/**
 * The longest whole-line prefix of a file that fits the allowance, with the
 * exact interval it covers. A prefix only grows, so the search is a bisection;
 * null when not even the first line fits.
 */
export function wholeLinePrefix(
  content: string,
  path: string,
  allowance: number,
  model: string | undefined,
): (Section & { endLine: number }) | null {
  const lines = content.split('\n');
  const render = (endLine: number): Section & { endLine: number } => ({
    ...section(
      path,
      sourceBlock(
        `${path} — lines 1-${endLine} of ${lines.length}`,
        lines.slice(0, endLine).join('\n'),
      ),
      model,
    ),
    endLine,
  });

  let best = render(1);
  if (best.tokens > allowance) return null;
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = render(mid);
    if (candidate.tokens > allowance) high = mid - 1;
    else {
      best = candidate;
      low = mid;
    }
  }
  return best;
}
