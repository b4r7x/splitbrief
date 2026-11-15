import { estimateTokens } from '../../../core/tokens/estimate.js';
import { BASE_OUTPUT_RESERVE_TOKENS } from '../../providers/api/budget.js';
import { resolveApplicationContextTokens } from '../../providers/api/runtime-context.js';
import {
  type Section,
  section,
  composeText,
  overflowingSections,
  wholeLinePrefix,
} from './compose.js';
import { type Mention, collectMentions, record } from './mentions.js';
import { readSource, sourceBlock, rankedRepoMapPaths } from './sources.js';
import type {
  ApiPlanningContextInput,
  ApiPlanningContext,
  ApiContextManifestEntry,
} from './types.js';

/**
 * The input window a PLAN packet packs optional source into: the seat's
 * application context minus the reserve its own answer needs. Dispatch-time
 * admission remeasures against the observed context.
 */
export function apiPlanningInputBudget(configuredContextLength: number | undefined): number {
  const { applicationContextTokens } = resolveApplicationContextTokens(
    configuredContextLength === undefined
      ? {}
      : { configuredContextTokens: configuredContextLength },
  );
  return Math.max(0, applicationContextTokens - BASE_OUTPUT_RESERVE_TOKENS);
}

/**
 * The §4 deterministic PLAN context packet. Required material — project
 * instructions, every artifact the step declares, and the current source of
 * every path the request, the briefs or those artifacts name — is included whole,
 * and refuses only over a Prompt budget the user set; optional source follows the
 * repo map's rank into whatever window is left, as whole-line prefixes with exact
 * intervals. A file that was not read is a named omission, never an unstated one.
 */
export async function buildApiPlanningContext(
  input: ApiPlanningContextInput,
): Promise<ApiPlanningContext> {
  const { projectDir, project, model } = input;
  const artifacts = input.artifacts ?? [];
  const availableTokens = Math.max(0, input.availableTokens);

  const manifest: ApiContextManifestEntry[] = [];
  const missingSections: string[] = [];
  // Everything this call carries counts against the allocation, whether the
  // packet itself spells it or the phase prompt already does.
  const carried: [string, string | undefined][] = [
    ['project instructions', project.markdown],
    ['request', input.request],
    ['operator steer', input.steer],
    ['skills', input.skills],
    ['repo map', input.repoMapInPrompt === true ? input.repoMap : undefined],
    ...(input.priorMessages ?? []).map((message): [string, string] => [
      'prior messages',
      message.content,
    ]),
  ];
  const counted: Section[] = carried
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([name, text]) => section(name, text, model));

  for (const { name, text, required } of artifacts) {
    const kind = required ? 'required' : 'optional';
    if (text.trim() === '') {
      if (!required) continue;
      manifest.push({ path: name, kind, state: 'missing' });
      missingSections.push(name);
      continue;
    }
    manifest.push({ path: name, kind, state: 'included' });
    counted.push(section(name, text, model));
  }

  const mentions = new Map<string, Mention>();
  collectMentions(input.request, mentions);
  if (input.steer !== undefined) collectMentions(input.steer, mentions);
  for (const artifact of artifacts) collectMentions(artifact.text, mentions);
  for (const path of input.taskFiles ?? []) record(mentions, path, true, 'new');

  for (const path of ['AGENTS.md', 'CLAUDE.md']) {
    const read = await readSource(projectDir, path);
    if (read.kind !== 'missing') record(mentions, path, true, 'existing');
  }
  const mentioned = await requiredSources(projectDir, mentions, model);
  manifest.push(...mentioned.manifest);
  missingSections.push(...mentioned.missing);

  const optionalSources = [];
  for (const path of rankedRepoMapPaths(input.repoMap)) {
    if (mentions.has(path)) continue;
    const read = await readSource(projectDir, path);
    const index = manifest.length;
    manifest.push({ path, kind: 'optional', state: read.kind === 'text' ? 'omitted' : read.kind });
    if (read.kind === 'text') optionalSources.push({ path, read, index });
  }

  const blocks = mentioned.blocks.map((part) => part.text);
  const measure = (texts: readonly string[], entries: readonly ApiContextManifestEntry[]) =>
    input.measureInput?.(composeText(project, texts, entries));
  const requiredTokens =
    measure(blocks, manifest) ??
    counted.reduce((total, part) => total + part.tokens, 0) +
      mentioned.blocks.reduce((total, part) => total + part.tokens, 0);

  if (missingSections.length > 0) {
    return {
      kind: 'insufficient-context',
      cause: mentioned.unsupported ? 'unsupported-required' : 'missing-required',
      missingSections,
      requiredTokens,
      availableTokens,
      manifest,
    };
  }

  const { userBudgetTokens } = input;
  if (userBudgetTokens !== undefined && requiredTokens > userBudgetTokens) {
    const overflowing = overflowingSections([...counted, ...mentioned.blocks], userBudgetTokens);
    return {
      kind: 'insufficient-context',
      cause: 'input-budget',
      missingSections: overflowing,
      requiredTokens,
      availableTokens: userBudgetTokens,
      // A section that does not fit was read but is not supplied: the manifest
      // says omitted rather than claiming the call would have carried it.
      manifest: manifest.map((entry) =>
        overflowing.includes(entry.path) ? { ...entry, state: 'omitted' } : entry,
      ),
    };
  }

  const packet = optionalSourcesWithin(
    optionalSources,
    { manifest, blocks },
    { remaining: availableTokens - requiredTokens, availableTokens, measure, model },
  );
  return {
    kind: 'complete',
    text: composeText(project, packet.blocks, packet.manifest),
    manifest: packet.manifest,
  };
}

/**
 * The current source of each mentioned path, in path order: a readable file goes
 * whole; an explicit mention that cannot be read is a named gap.
 */
async function requiredSources(
  projectDir: string,
  mentions: ReadonlyMap<string, Mention>,
  model: string | undefined,
): Promise<{
  manifest: ApiContextManifestEntry[];
  blocks: Section[];
  missing: string[];
  unsupported: boolean;
}> {
  const manifest: ApiContextManifestEntry[] = [];
  const blocks: Section[] = [];
  const missing: string[] = [];
  let unsupported = false;
  for (const mention of [...mentions.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const read = await readSource(projectDir, mention.path);
    if (read.kind === 'text') {
      manifest.push({
        path: mention.path,
        kind: 'required',
        state: 'included',
        sha256: read.sha256,
      });
      blocks.push(
        section(
          mention.path,
          sourceBlock(`${mention.path} — whole file, sha256 ${read.sha256}`, read.content),
          model,
        ),
      );
      continue;
    }
    if (!mention.explicit) continue;
    if (read.kind === 'unsupported') {
      manifest.push({ path: mention.path, kind: 'required', state: 'unsupported' });
      missing.push(mention.path);
      unsupported = true;
      continue;
    }
    // A path the text asked for but that is not there yet is recorded absent; one
    // it described as existing is evidence this call was promised and denied.
    if (mention.disposition === 'existing') {
      manifest.push({ path: mention.path, kind: 'required', state: 'missing' });
      missing.push(mention.path);
    } else {
      manifest.push({ path: mention.path, kind: 'optional', state: 'missing' });
    }
  }
  return { manifest, blocks, missing, unsupported };
}

/**
 * Packs the ranked optional source into the window the required packet left:
 * each file whole when it fits, else its longest whole-line prefix that fits.
 */
function optionalSourcesWithin(
  sources: readonly Readonly<{
    path: string;
    read: Readonly<{ content: string; sha256: string }>;
    index: number;
  }>[],
  packet: Readonly<{ manifest: readonly ApiContextManifestEntry[]; blocks: readonly string[] }>,
  budget: Readonly<{
    remaining: number;
    availableTokens: number;
    measure: (
      texts: readonly string[],
      entries: readonly ApiContextManifestEntry[],
    ) => number | undefined;
    model: string | undefined;
  }>,
): { manifest: ApiContextManifestEntry[]; blocks: string[] } {
  const manifest = [...packet.manifest];
  const blocks = [...packet.blocks];
  const { availableTokens, measure, model } = budget;
  let { remaining } = budget;
  for (const { path, read, index } of sources) {
    const fits = (text: string, entry: ApiContextManifestEntry): boolean => {
      const entries = manifest.map((current, position) => (position === index ? entry : current));
      const measured = measure([...blocks, text], entries);
      return measured === undefined
        ? estimateTokens(text, model) <= remaining
        : measured <= availableTokens;
    };
    const whole = sourceBlock(`${path} — whole file, sha256 ${read.sha256}`, read.content);
    const wholeEntry: ApiContextManifestEntry = {
      path,
      kind: 'optional',
      state: 'included',
      sha256: read.sha256,
    };
    if (fits(whole, wholeEntry)) {
      manifest[index] = wholeEntry;
      blocks.push(whole);
      remaining -= estimateTokens(whole, model);
      continue;
    }
    let allowance = Math.max(0, remaining);
    let excerpt = wholeLinePrefix(read.content, path, allowance, model);
    while (excerpt !== null) {
      const entry: ApiContextManifestEntry = {
        path,
        kind: 'optional',
        state: 'excerpt',
        startLine: 1,
        endLine: excerpt.endLine,
        sha256: read.sha256,
      };
      if (fits(excerpt.text, entry)) {
        manifest[index] = entry;
        blocks.push(excerpt.text);
        remaining -= excerpt.tokens;
        break;
      }
      allowance = Math.floor(allowance * 0.9);
      excerpt = wholeLinePrefix(read.content, path, allowance, model);
    }
  }
  return { manifest, blocks };
}
