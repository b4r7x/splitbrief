type OpenDelimiter = '`' | '~~' | '**' | '*';

// Appends closers (LIFO) for inline constructs left open at a streaming chunk
// boundary; balanced text is returned unchanged, so a completed message
// re-renders byte-identical to a from-scratch render.
export function repairMarkdownTailChunk(chunkText: string): string {
  const open: OpenDelimiter[] = [];
  let completion = '';
  let index = 0;

  while (index < chunkText.length) {
    const char = chunkText[index];

    if (open[open.length - 1] === '`') {
      if (char === '`') open.pop();
      index += 1;
      continue;
    }
    if (char === '`') {
      open.push('`');
      index += 1;
      continue;
    }
    if (char === '~') {
      if (chunkText[index + 1] === '~') {
        // a closing-position run that closes nothing ('a~~b') is literal,
        // never an opener
        if (closesEmphasis(chunkText[index - 1])) {
          if (open[open.length - 1] === '~~') open.pop();
        } else if (opensEmphasis(chunkText[index + 2])) {
          open.push('~~');
        }
        index += 2;
        continue;
      }
      if (index + 1 === chunkText.length && open[open.length - 1] === '~~') {
        // lone tail tilde: the closing '~~' arrived split mid-delimiter
        completion = '~';
        open.pop();
      }
      index += 1;
      continue;
    }
    if (char !== '*') {
      index += 1;
      continue;
    }

    let run = 1;
    while (chunkText[index + run] === '*') run += 1;
    const before = chunkText[index - 1];
    const after = chunkText[index + run];
    const atTail = index + run === chunkText.length;
    index += run;

    let remaining = run;
    if (closesEmphasis(before)) {
      const depth = open.length;
      while (remaining > 0) {
        const top = open[open.length - 1];
        if ((top !== '*' && top !== '**') || top.length > remaining) break;
        open.pop();
        remaining -= top.length;
      }
      if (remaining === 1 && atTail && open[open.length - 1] === '**') {
        // tail '*' against an open '**': the closer arrived split mid-delimiter
        completion = '*';
        open.pop();
        remaining = 0;
      }
      // a closing-position run that closed nothing ('O(n*m)', 'src/**') is
      // literal, never an opener
      if (open.length === depth) remaining = 0;
    }
    if (remaining > 0 && opensEmphasis(after)) pushAsteriskOpeners(open, remaining);
  }

  if (open.length === 0 && completion === '') return chunkText;
  return chunkText + completion + open.reverse().join('');
}

// CommonMark-style flanking: a run closes only after non-space and opens only
// before non-space, so literal stars in prose (bullets, '3 * 4') never register
// as openers. A run at the chunk end may always open — the rest of the
// construct simply has not streamed in yet.
function closesEmphasis(before: string | undefined): boolean {
  return before !== undefined && !/\s/.test(before);
}

function opensEmphasis(after: string | undefined): boolean {
  return after === undefined || !/\s/.test(after);
}

// '***' opens italic-then-bold so a later '**' closes the bold first:
// '***a** b*' balances in LIFO order.
function pushAsteriskOpeners(open: OpenDelimiter[], count: number): void {
  let remaining = count;
  while (remaining >= 3) {
    open.push('*');
    open.push('**');
    remaining -= 3;
  }
  if (remaining === 2) open.push('**');
  if (remaining === 1) open.push('*');
}
