export function parseShellCommand(input: string): string[] {
  return scanShellWords(input).words;
}

export function scanShellWords(input: string): { words: string[]; complete: boolean } {
  const words: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  let complete = true;

  for (let index = 0; index < input.length; index += 1) {
    const ch = input.charAt(index);
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (quote === "'") {
      current += ch;
      continue;
    }
    if (ch === '\\') {
      const next = input[index + 1];
      if (next === undefined) {
        complete = false;
      } else if (quote === null || '$`"\\\n'.includes(next)) {
        if (next !== '\n') {
          current += next;
          tokenStarted = true;
        }
        index += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        tokenStarted = true;
        continue;
      }
      if (/\s/u.test(ch)) {
        if (tokenStarted) {
          words.push(current);
          current = '';
          tokenStarted = false;
        }
        continue;
      }
      if (ch === '$' && (input[index + 1] === "'" || input[index + 1] === '"')) complete = false;
    }
    current += ch;
    tokenStarted = true;
  }
  if (tokenStarted) words.push(current);
  return { words, complete: complete && quote === null };
}
