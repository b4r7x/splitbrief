import { type Section, section, composeText, overflowingSections } from './compose.js';
import { type Mention, collectMentions, record } from './mentions.js';
import { readSource, sourceBlock } from './sources.js';
import type {
  ApiPlanningContextInput,
  ApiPlanningContext,
  ApiContextManifestEntry,
} from './types.js';

/**
 * The PLAN context packet carries project instructions and the current source of
 * named files. It sends required files whole and refuses when required material
 * is missing or exceeds a Prompt budget the user set.
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

  const blocks = mentioned.blocks.map((part) => part.text);
  const text = composeText(project, blocks, manifest);
  const requiredTokens =
    input.measureInput?.(text) ??
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

  return {
    kind: 'complete',
    text,
    manifest,
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
