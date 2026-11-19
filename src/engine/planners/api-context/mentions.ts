const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;
const BARE_PATH_RE =
  /(?<![\w./-])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8})(?![\w/-])/g;
const LINE_NUMBER_SUFFIX_RE = /:\d+(?::\d+)?$/;
const EXPLICIT_PATH_INTENT_RE =
  /\b(modify|update|edit|change|refactor|rewrite|replace|extend|fix|adjust|patch|remove|delete|create|add|generate|introduce|new)\s+(?:(?:the|this|current|existing)\s+)?/gi;

/** Words that describe a named path as already in the project. */
const EXISTING_WORDS =
  'modify update edit change refactor rewrite replace extend fix adjust patch remove delete existing current'.split(
    ' ',
  );
const NEW_PATH_INTENTS = new Set(['create', 'add', 'generate', 'introduce', 'new']);

export const PATH_MAX_LENGTH = 200;

export type Mention = {
  path: string;
  /** Backticked or declared by a brief: an explicit claim, not prose. */
  explicit: boolean;
  /** How the text that named it described it. */
  disposition: 'existing' | 'new';
};

export function absolutePathsNamed(text: string): string[] {
  const mentions: Array<{ path: string; index: number }> = [];
  const recordPath = (raw: string, index: number): void => {
    const path = normalizeCandidate(raw.replace(/^`+|`+$/g, '').replace(/\\ /g, ' '));
    if (path.startsWith('/')) mentions.push({ path, index });
  };
  const rest = text.replace(
    /(?<=^|[\s([{])(["'`])(\/[^\n]*?)\1(?=$|[\s.,;:!?)\]}])/g,
    (span: string, _quote: string, path: string, index: number) => {
      recordPath(path, index);
      return ' '.repeat(span.length);
    },
  );
  for (const token of rest.matchAll(/(?:\\ |[^\s])+/g)) {
    recordPath(token[0], token.index);
  }
  mentions.sort((a, b) => a.index - b.index);
  return [...new Set(mentions.map((mention) => mention.path))];
}

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

export function record(
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
export function collectMentions(text: string, into: Map<string, Mention>): void {
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
