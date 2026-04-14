type FrontmatterValue = string | string[];
type FrontmatterRecord = Record<string, FrontmatterValue>;

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArray(value: string): string[] {
  if (value === '[]' || value.length === 0) return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  return [stripQuotes(value.trim())];
}

export function parseSimpleYamlFrontmatter(raw: string): FrontmatterRecord | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = match?.[1];
  if (body === undefined) return null;

  const result: FrontmatterRecord = {};
  const lines = body.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (value === '') {
      // Possible block array on subsequent lines
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next === undefined) break;
        const trimmed = next.trimStart();
        if (trimmed.startsWith('- ')) {
          items.push(stripQuotes(trimmed.slice(2).trim()));
          j++;
        } else {
          break;
        }
      }
      if (items.length > 0) {
        result[key] = items;
        i = j;
        continue;
      }
      result[key] = '';
      i++;
      continue;
    }

    if (value.startsWith('[')) {
      result[key] = parseInlineArray(value);
    } else {
      result[key] = stripQuotes(value);
    }
    i++;
  }

  return result;
}

export function extractFrontmatter(
  raw: string,
): { frontmatter: FrontmatterRecord | null; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: raw };
  const frontmatter = parseSimpleYamlFrontmatter(raw);
  const body = raw.slice(match[0].length);
  return { frontmatter, body };
}
