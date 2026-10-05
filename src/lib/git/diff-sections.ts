// A path with a space is spelled plainly; one with a non-ASCII or control byte
// is C-quoted, and a coverage check that could not read it would refuse a file
// the diff does carry.
const DIFF_HEADER_RE =
  /^diff --git (?:a\/(.+)|"a\/((?:\\.|[^"\\])*)") (?:b\/(.+)|"b\/((?:\\.|[^"\\])*)")$/m;
const OCTAL_ESCAPE_RE = /\\([0-7]{3})/g;
const LITERAL_ESCAPE_RE = /\\([\\"])/g;

/** The path a C-quoted header names, back in the spelling git status uses. */
function unquoteHeaderPath(raw: string): string {
  const bytes = raw
    .replace(LITERAL_ESCAPE_RE, '$1')
    .replace(OCTAL_ESCAPE_RE, (_, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 8)),
    );
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

export function splitDiffByFile(diff: string): { before: string; after: string; diff: string }[] {
  const sections: { before: string; after: string; diff: string }[] = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const header = DIFF_HEADER_RE.exec(section);
    if (header === null) continue;
    const before = header[1] ?? unquoteHeaderPath(header[2] ?? '');
    const after = header[3] ?? unquoteHeaderPath(header[4] ?? '');
    sections.push({ before, after, diff: section });
  }
  return sections;
}
