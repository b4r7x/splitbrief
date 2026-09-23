// A substitution or an unknown variable leaves nothing certain in a word past it; the three
// variables a path scope can answer stay marked until the word is resolved.
export const OPAQUE = '\u0000';
export const HOME_MARK = '\u0001';
export const TMPDIR_MARK = '\u0002';
export const PWD_MARK = '\u0003';

type Redirect = Readonly<{ access: 'read' | 'write'; target: string }>;
type SimpleCommand = { words: string[]; redirects: Redirect[] };
type Lexed = { commands: SimpleCommand[]; nested: string[] };

function variableMark(name: string): string {
  if (name === 'HOME') return HOME_MARK;
  if (name === 'TMPDIR') return TMPDIR_MARK;
  if (name === 'PWD') return PWD_MARK;
  return OPAQUE;
}

/** The index just past the `)` that closes a group opened before `start`; quotes are skipped whole. */
function closingParen(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') index += 2;
    else if (char === "'" || char === '"')
      index = Math.max(source.indexOf(char, index + 1), index) + 1;
    else {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      index += 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function closingBacktick(source: string, start: number): number {
  let index = start;
  while (index < source.length && source[index] !== '`') index += source[index] === '\\' ? 2 : 1;
  return index;
}

/** `$…` at `start`: the text it contributes to the word and where the lexer resumes. */
function readDollar(
  source: string,
  start: number,
  nested: string[],
): { text: string; end: number } {
  const next = source[start + 1];
  if (next === '(' && source[start + 2] === '(') {
    return { text: OPAQUE, end: closingParen(source, start + 2) };
  }
  if (next === '(') {
    const end = closingParen(source, start + 2);
    nested.push(source.slice(start + 2, end - 1));
    return { text: OPAQUE, end };
  }
  if (next === '{') {
    const close = source.indexOf('}', start + 2);
    const end = close === -1 ? source.length : close + 1;
    const name = source.slice(start + 2, end - 1);
    return { text: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? variableMark(name) : OPAQUE, end };
  }
  if (next === "'") {
    const close = source.indexOf("'", start + 2);
    const end = close === -1 ? source.length : close + 1;
    return { text: source.slice(start + 2, end - 1), end };
  }
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(start + 1))?.[0];
  if (name !== undefined) return { text: variableMark(name), end: start + 1 + name.length };
  if (next !== undefined && /[0-9?$!#@*-]/.test(next)) return { text: OPAQUE, end: start + 2 };
  return { text: '$', end: start + 1 };
}

function readDoubleQuoted(
  source: string,
  start: number,
  nested: string[],
): { text: string; end: number } {
  let text = '';
  let index = start + 1;
  while (index < source.length && source[index] !== '"') {
    const char = source.charAt(index);
    if (char === '\\' && '$`"\\\n'.includes(source.charAt(index + 1))) {
      if (source[index + 1] !== '\n') text += source[index + 1];
      index += 2;
    } else if (char === '$') {
      const dollar = readDollar(source, index, nested);
      text += dollar.text;
      index = dollar.end;
    } else if (char === '`') {
      const end = closingBacktick(source, index + 1);
      nested.push(source.slice(index + 1, end));
      text += OPAQUE;
      index = end + 1;
    } else {
      text += char;
      index += 1;
    }
  }
  return { text, end: index + 1 };
}

type RedirectOperator =
  | { kind: 'read' | 'write' | 'herestring' | 'dup' }
  | { kind: 'heredoc'; stripTabs: boolean };

function readRedirect(source: string, start: number): { operator: RedirectOperator; end: number } {
  const rest = source.slice(start);
  const dup = (length: number) => {
    const target = /^(?:\d+|-)/.exec(rest.slice(length))?.[0];
    return target === undefined
      ? { operator: { kind: 'write' as const }, end: start + length }
      : { operator: { kind: 'dup' as const }, end: start + length + target.length };
  };
  if (rest.startsWith('&>>')) return { operator: { kind: 'write' }, end: start + 3 };
  if (rest.startsWith('&>')) return { operator: { kind: 'write' }, end: start + 2 };
  if (rest.startsWith('<<<')) return { operator: { kind: 'herestring' }, end: start + 3 };
  if (rest.startsWith('<<-'))
    return { operator: { kind: 'heredoc', stripTabs: true }, end: start + 3 };
  if (rest.startsWith('<<'))
    return { operator: { kind: 'heredoc', stripTabs: false }, end: start + 2 };
  if (rest.startsWith('<>')) return { operator: { kind: 'write' }, end: start + 2 };
  if (rest.startsWith('<&')) {
    const result = dup(2);
    return result.operator.kind === 'dup' ? result : { operator: { kind: 'read' }, end: start + 2 };
  }
  if (rest.startsWith('<')) return { operator: { kind: 'read' }, end: start + 1 };
  if (rest.startsWith('>>') || rest.startsWith('>|'))
    return { operator: { kind: 'write' }, end: start + 2 };
  if (rest.startsWith('>&')) return dup(2);
  return { operator: { kind: 'write' }, end: start + 1 };
}

/** Where the lexer resumes after the bodies of the here-documents opened on the line just ended. */
function skipHeredocBodies(
  source: string,
  start: number,
  heredocs: readonly { delimiter: string; stripTabs: boolean }[],
): number {
  let index = start;
  for (const heredoc of heredocs) {
    while (index < source.length) {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd === -1 ? source.length : lineEnd;
      const line = source.slice(index, end);
      index = end + 1;
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
    }
  }
  return index;
}

function isWordBreak(char: string | undefined): boolean {
  return char === undefined || /[\s;&|()<>]/.test(char);
}

/**
 * A POSIX-shell reading of a command line good enough to find the paths it
 * names: quotes and escapes resolved, command and process substitutions lifted
 * out as nested scripts, redirections separated from arguments, and here-document
 * bodies skipped — their contents are data the command writes, never paths.
 */
export function lexShell(source: string): Lexed {
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  let word = '';
  let inWord = false;
  let pending: RedirectOperator | null = null;
  let heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  const endWord = () => {
    if (!inWord) return;
    const text = word;
    word = '';
    inWord = false;
    const redirect = pending;
    pending = null;
    if (redirect === null) current.words.push(text);
    else if (redirect.kind === 'heredoc') {
      heredocs.push({ delimiter: text, stripTabs: redirect.stripTabs });
    } else if (redirect.kind === 'read' || redirect.kind === 'write') {
      current.redirects.push({ access: redirect.kind, target: text });
    }
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [] };
  };

  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source[index + 1];
    if (char === '\n') {
      endCommand();
      index = skipHeredocBodies(source, index + 1, heredocs);
      heredocs = [];
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      index += 1;
    } else if (char === '#' && !inWord) {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd === -1 ? source.length : lineEnd;
    } else if (char === '\\') {
      if (next !== '\n') {
        word += next ?? '';
        inWord = true;
      }
      index += 2;
    } else if (char === "'") {
      const close = source.indexOf("'", index + 1);
      const end = close === -1 ? source.length : close;
      word += source.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '"') {
      const quoted = readDoubleQuoted(source, index, nested);
      word += quoted.text;
      inWord = true;
      index = quoted.end;
    } else if (char === '$') {
      const dollar = readDollar(source, index, nested);
      word += dollar.text;
      inWord = true;
      index = dollar.end;
    } else if (char === '`') {
      const end = closingBacktick(source, index + 1);
      nested.push(source.slice(index + 1, end));
      word += OPAQUE;
      inWord = true;
      index = end + 1;
    } else if (char === '~' && !inWord && (next === '/' || isWordBreak(next))) {
      word += HOME_MARK;
      inWord = true;
      index += 1;
    } else if ((char === '<' || char === '>') && next === '(') {
      const end = closingParen(source, index + 2);
      nested.push(source.slice(index + 2, end - 1));
      word += OPAQUE;
      inWord = true;
      index = end;
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      // `2>` names a descriptor, not an argument.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      const redirect = readRedirect(source, index);
      if (redirect.operator.kind !== 'dup') pending = redirect.operator;
      index = redirect.end;
    } else if (';&|()'.includes(char)) {
      endCommand();
      index += 1;
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  endCommand();
  return { commands, nested };
}
