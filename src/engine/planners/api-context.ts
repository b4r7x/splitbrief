import { estimateTokens } from '../../core/tokens/estimate.js';
import { readConfinedEntry } from '../orchestrator/approval/file-snapshots/entry.js';
import { BASE_OUTPUT_RESERVE_TOKENS } from '../providers/api-budget.js';
import { resolveApplicationContextTokens } from '../providers/runtime-context.js';
import type { ProjectContext } from './context.js';
import type { PriorMessage } from './types.js';

type ApiContextEntryKind = 'required' | 'optional';
type ApiContextEntryState = 'included' | 'excerpt' | 'omitted' | 'missing' | 'unsupported';

/** One line of the packet's manifest: what was supplied, and in what shape. */
export type ApiContextManifestEntry = Readonly<{
  path: string;
  kind: ApiContextEntryKind;
  state: ApiContextEntryState;
  startLine?: number;
  endLine?: number;
  sha256?: string;
}>;

/** One prior planning document handed to this call. */
export type ApiPlanningArtifact = Readonly<{
  /** Logical name, as the manifest and a refusal spell it (`spec.md`). */
  name: string;
  text: string;
  /** The step declares it, so an empty one is missing evidence, not absence. */
  required: boolean;
}>;

type ApiPlanningContextInput = Readonly<{
  projectDir: string;
  /** Canonical instructions and project metadata, with what they left out. */
  project: ProjectContext;
  /** The feature request this run is planning. */
  request: string;
  artifacts?: readonly ApiPlanningArtifact[] | undefined;
  /** Exact declared targets of the current briefs. */
  taskFiles?: readonly string[] | undefined;
  /** What the operator said for this call, and the rejections it must respect. */
  steer?: string | undefined;
  priorMessages?: readonly PriorMessage[] | undefined;
  /** The ranked repo map, highest rank first, as the run already built it. */
  repoMap?: string | undefined;
  /** True when this call's prompt carries the map, so the budget counts it. */
  repoMapInPrompt?: boolean | undefined;
  skills?: string | undefined;
  /** Input-token allocation this packet and everything beside it must fit. */
  availableTokens: number;
  /** Selected model, for the estimate's character ratio. */
  model?: string | undefined;
  /** Measures the complete wire prompt, including framing and estimate margin. */
  measureInput?: ((packet: string) => number) | undefined;
}>;

export type ApiPlanningContext =
  | Readonly<{
      kind: 'complete';
      text: string;
      manifest: readonly ApiContextManifestEntry[];
    }>
  | Readonly<{
      kind: 'insufficient-context';
      cause: 'missing-required' | 'unsupported-required' | 'input-budget';
      missingSections: readonly string[];
      requiredTokens: number;
      availableTokens: number;
      manifest: readonly ApiContextManifestEntry[];
    }>;

const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;
const BARE_PATH_RE =
  /(?<![\w./-])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8})(?![\w/-])/g;
const LINE_NUMBER_SUFFIX_RE = /:\d+(?::\d+)?$/;
const BACKTICK_RUN_RE = /`+/g;
const REPO_MAP_HEADING_RE = /^([^\s:][^:]*):$/;
const EXPLICIT_PATH_INTENT_RE =
  /\b(modify|update|edit|change|refactor|rewrite|replace|extend|fix|adjust|patch|remove|delete|create|add|generate|introduce|new)\s+(?:(?:the|this|current|existing)\s+)?/gi;

/** Words that describe a named path as already in the project. */
const EXISTING_WORDS =
  'modify update edit change refactor rewrite replace extend fix adjust patch remove delete existing current'.split(
    ' ',
  );
const NEW_PATH_INTENTS = new Set(['create', 'add', 'generate', 'introduce', 'new']);

const PATH_MAX_LENGTH = 200;

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

/**
 * The input allocation a PLAN packet may occupy: the seat's application context
 * minus the reserve its own answer needs. Dispatch-time admission remeasures
 * against the observed context and remains the authority.
 */
export function apiPlanningInputBudget(configuredContextLength: number | undefined): number {
  const { applicationContextTokens } = resolveApplicationContextTokens(
    configuredContextLength === undefined
      ? {}
      : { configuredContextTokens: configuredContextLength },
  );
  return Math.max(0, applicationContextTokens - BASE_OUTPUT_RESERVE_TOKENS);
}

type Mention = {
  path: string;
  /** Backticked or declared by a brief: an explicit claim, not prose. */
  explicit: boolean;
  /** How the text that named it described it. */
  disposition: 'existing' | 'new';
};

function isCandidatePath(raw: string): boolean {
  if (raw.length === 0 || raw.length > PATH_MAX_LENGTH) return false;
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\u0000')) return false;
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  const base = segments[segments.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 1) return false;
  const extension = base.slice(dot + 1);
  if (extension.length === 0 || extension.length > 8) return false;
  // `e.g` and `i.e` are prose: a one-character stem is never a project file.
  return segments.length > 1 || dot >= 2;
}

function describesExisting(line: string): boolean {
  const lower = line.toLowerCase();
  return EXISTING_WORDS.some((word) => lower.includes(word));
}

function normalizeCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^[([{"']+/, '')
    .replace(/[.,;:!?)}\]"']+$/, '')
    .replace(LINE_NUMBER_SUFFIX_RE, '');
}

function looksLikeExplicitPath(raw: string): boolean {
  if (raw === 'e.g' || raw === 'i.e' || raw.includes('://')) return false;
  return (
    raw.includes('/') ||
    raw.startsWith('.') ||
    raw.includes('.') ||
    /^(?:Dockerfile|Makefile|Rakefile|Procfile|LICENSE|README|CHANGELOG)$/i.test(raw)
  );
}

function isListConnector(raw: string): boolean {
  return /^(?:and|or|plus|also|&)$/i.test(raw.replace(/^[,]+|[,]+$/g, ''));
}

function collectIntentPaths(line: string, into: Map<string, Mention>): void {
  const withoutBackticks = line.replace(BACKTICK_SPAN_RE, ' ');
  const intents = [...withoutBackticks.matchAll(EXPLICIT_PATH_INTENT_RE)];
  for (const [index, match] of intents.entries()) {
    const disposition = NEW_PATH_INTENTS.has((match[1] ?? '').toLowerCase()) ? 'new' : 'existing';
    // Only consume the path list directly after this verb. The next explicit
    // verb and a clause separator bound it, so a later create clause or URL is
    // not mistaken for an existing source file.
    const start = (match.index ?? 0) + match[0].length;
    const end = intents[index + 1]?.index ?? withoutBackticks.length;
    const clause = withoutBackticks.slice(start, end).split(/[;!?]/, 1)[0] ?? '';
    let foundPath = false;
    for (const candidate of clause.split(/\s+/)) {
      if (isListConnector(candidate)) continue;
      const path = normalizeCandidate(candidate);
      if (looksLikeExplicitPath(path)) {
        record(into, path, true, disposition);
        foundPath = true;
        continue;
      }
      if (foundPath) break;
    }
  }
}

function record(
  into: Map<string, Mention>,
  path: string,
  explicit: boolean,
  disposition: Mention['disposition'],
): void {
  if (!explicit && !isCandidatePath(path)) return;
  const existing = into.get(path);
  if (existing === undefined) {
    into.set(path, { path, explicit, disposition });
    return;
  }
  if (explicit && !existing.explicit) existing.disposition = disposition;
  existing.explicit = existing.explicit || explicit;
  if (disposition === 'existing') existing.disposition = 'existing';
}

/**
 * Every project-relative path a block of text names. A backticked span is an
 * explicit claim; a bare path is recognized too, but only an explicit claim can
 * turn a missing or unreadable file into a refusal, so prose never blocks a run.
 */
function collectMentions(text: string, into: Map<string, Mention>): void {
  for (const line of text.split('\n')) {
    const disposition = describesExisting(line) ? 'existing' : 'new';
    for (const match of line.matchAll(BACKTICK_SPAN_RE)) {
      record(into, normalizeCandidate(match[1] ?? ''), true, disposition);
    }
    for (const match of line.replace(BACKTICK_SPAN_RE, ' ').matchAll(BARE_PATH_RE)) {
      record(into, normalizeCandidate(match[1] ?? ''), false, disposition);
    }
    collectIntentPaths(line, into);
  }
}

type SourceRead =
  | { kind: 'text'; content: string; sha256: string }
  | { kind: 'missing' }
  | { kind: 'unsupported' };

/** Strict: an invalid sequence throws instead of decoding to U+FFFD. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A symlink, directory, special file, binary payload or invalid UTF-8 is
 * unsupported — never silently absent and never silently repaired. */
async function readSource(projectDir: string, path: string): Promise<SourceRead> {
  if (
    path.length === 0 ||
    path.length > PATH_MAX_LENGTH ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    return { kind: 'unsupported' };
  let entry: Awaited<ReturnType<typeof readConfinedEntry>>;
  try {
    entry = await readConfinedEntry(projectDir, path);
  } catch {
    return { kind: 'unsupported' };
  }
  if (entry.kind === 'absent') return { kind: 'missing' };
  if (entry.bytes.includes(0)) return { kind: 'unsupported' };
  try {
    return { kind: 'text', content: utf8.decode(entry.bytes), sha256: entry.sha256 };
  } catch {
    return { kind: 'unsupported' };
  }
}

function fenceFor(content: string): string {
  let longest = 2;
  for (const run of content.match(BACKTICK_RUN_RE) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

function sourceBlock(heading: string, content: string): string {
  const fence = fenceFor(content);
  return `### ${heading}\n${fence}\n${content}\n${fence}`;
}

/** The repo map's own order is its rank; a path it lists once is listed once. */
function rankedRepoMapPaths(repoMap: string | undefined): readonly string[] {
  if (repoMap === undefined || repoMap === '') return [];
  const ranked = new Set<string>();
  for (const line of repoMap.split('\n')) {
    const path = REPO_MAP_HEADING_RE.exec(line)?.[1];
    if (path !== undefined && isCandidatePath(path)) ranked.add(path);
  }
  return [...ranked];
}

type Section = { name: string; text: string; tokens: number };

function section(name: string, text: string, model: string | undefined): Section {
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

function composeText(
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
function overflowingSections(sections: readonly Section[], availableTokens: number): string[] {
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
function wholeLinePrefix(
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

/**
 * The §4 deterministic PLAN context packet. Required material — project
 * instructions, every artifact the step declares, and the current source of
 * every path the request, the briefs or those artifacts name — is included whole
 * or the packet refuses; optional source follows the repo map's rank into
 * whatever allocation is left, as whole-line prefixes with exact intervals. A
 * file that was not read is a named omission, never an unstated one.
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

  const requiredBlocks: Section[] = [];
  let unsupportedRequired = false;
  for (const path of ['AGENTS.md', 'CLAUDE.md']) {
    const read = await readSource(projectDir, path);
    if (read.kind !== 'missing') record(mentions, path, true, 'existing');
  }
  for (const mention of [...mentions.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const read = await readSource(projectDir, mention.path);
    if (read.kind === 'text') {
      manifest.push({
        path: mention.path,
        kind: 'required',
        state: 'included',
        sha256: read.sha256,
      });
      requiredBlocks.push(
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
      missingSections.push(mention.path);
      unsupportedRequired = true;
      continue;
    }
    // A path the text asked for but that is not there yet is recorded absent; one
    // it described as existing is evidence this call was promised and denied.
    if (mention.disposition === 'existing') {
      manifest.push({ path: mention.path, kind: 'required', state: 'missing' });
      missingSections.push(mention.path);
    } else {
      manifest.push({ path: mention.path, kind: 'optional', state: 'missing' });
    }
  }

  const optionalSources = [];
  for (const path of rankedRepoMapPaths(input.repoMap)) {
    if (mentions.has(path)) continue;
    const read = await readSource(projectDir, path);
    const index = manifest.length;
    manifest.push({ path, kind: 'optional', state: read.kind === 'text' ? 'omitted' : read.kind });
    if (read.kind === 'text') optionalSources.push({ path, read, index });
  }

  const blocks = requiredBlocks.map((part) => part.text);
  const measure = (texts: readonly string[], entries: readonly ApiContextManifestEntry[]) =>
    input.measureInput?.(composeText(project, texts, entries));
  const requiredTokens =
    measure(blocks, manifest) ??
    counted.reduce((total, part) => total + part.tokens, 0) +
      requiredBlocks.reduce((total, part) => total + part.tokens, 0);

  if (missingSections.length > 0) {
    return {
      kind: 'insufficient-context',
      cause: unsupportedRequired ? 'unsupported-required' : 'missing-required',
      missingSections,
      requiredTokens,
      availableTokens,
      manifest,
    };
  }

  if (requiredTokens > availableTokens) {
    const overflowing = overflowingSections([...counted, ...requiredBlocks], availableTokens);
    return {
      kind: 'insufficient-context',
      cause: 'input-budget',
      missingSections: overflowing,
      requiredTokens,
      availableTokens,
      // A section that does not fit was read but is not supplied: the manifest
      // says omitted rather than claiming the call would have carried it.
      manifest: manifest.map((entry) =>
        overflowing.includes(entry.path) ? { ...entry, state: 'omitted' } : entry,
      ),
    };
  }

  let remaining = availableTokens - requiredTokens;
  for (const { path, read, index } of optionalSources) {
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

  return { kind: 'complete', text: composeText(project, blocks, manifest), manifest };
}
