import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { ClarificationQuestionSchema } from '../../core/schemas/question.js';
import { warnError } from '../../lib/warn.js';

const MARKER_PREFIX = '<!-- Q:';
const MARKER_SUFFIX = ' -->';

function narrowQuestion(raw: unknown): ClarificationQuestion | null {
  const result = ClarificationQuestionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function findBalancedBrace(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface MarkerSpan {
  start: number;
  end: number;
}

function scanMarkerSpans(text: string): MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(MARKER_PREFIX, searchFrom);
    if (start === -1) break;

    const jsonStart = start + MARKER_PREFIX.length;
    if (jsonStart >= text.length || text[jsonStart] !== '{') {
      searchFrom = jsonStart;
      continue;
    }

    const jsonEnd = findBalancedBrace(text, jsonStart);
    if (jsonEnd === -1) {
      searchFrom = jsonStart + 1;
      continue;
    }

    const afterJson = jsonEnd + 1;
    if (text.substring(afterJson, afterJson + MARKER_SUFFIX.length) !== MARKER_SUFFIX) {
      searchFrom = jsonStart + 1;
      continue;
    }

    const end = afterJson + MARKER_SUFFIX.length;
    spans.push({ start, end });
    searchFrom = end;
  }

  return spans;
}

interface ScanResult {
  questions: ClarificationQuestion[];
  consumed: number;
}

function scanQuestions(text: string): ScanResult {
  const questions: ClarificationQuestion[] = [];
  let consumed = 0;

  for (const { start, end } of scanMarkerSpans(text)) {
    try {
      const json = text.substring(start + MARKER_PREFIX.length, end - MARKER_SUFFIX.length);
      const parsed = JSON.parse(json);
      const narrowed = narrowQuestion(parsed);
      if (narrowed) questions.push(narrowed);
    } catch (err) {
      warnError('question: malformed marker', err);
    }
    consumed = end;
  }

  return { questions, consumed };
}

export function extractQuestionsFromStream(text: string): ClarificationQuestion[] {
  return scanQuestions(text).questions;
}

export function createQuestionAccumulator() {
  let buffer = '';
  const seenIds = new Set<string>();
  const allQuestions: ClarificationQuestion[] = [];

  return {
    addChunk(chunk: string): ClarificationQuestion[] {
      buffer += chunk;
      const { questions, consumed } = scanQuestions(buffer);
      const newOnes = questions.filter((q) => !seenIds.has(q.id));
      for (const q of newOnes) {
        seenIds.add(q.id);
        allQuestions.push(q);
      }

      const tail = buffer.substring(consumed);
      const pendingPrefix = tail.lastIndexOf(MARKER_PREFIX);
      buffer = pendingPrefix === -1 ? '' : tail.substring(pendingPrefix);

      return newOnes;
    },
    getAll(): ClarificationQuestion[] {
      return [...allQuestions];
    },
  };
}

// Cap for text held back awaiting a marker that never completes; on overflow it is released
// verbatim — the markdown html-comment hiding keeps it invisible (layered defense).
const HOLD_CAP = 16 * 1024;

export function createQuestionMarkerStripper() {
  let held = '';
  // emittedTail tracks display output for blank-line collapse; lastSourceChar tracks source
  // text (which display omits: stripped markers, collapsed newlines) for line-start checks.
  let emittedTail = '';
  let lastSourceChar = '';
  let pendingLineBreak = false;
  let atSeam = false;

  const emit = (source: string): string => {
    if (source === '') return '';
    let text = source;
    if (pendingLineBreak) {
      pendingLineBreak = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
        atSeam = true;
      } else {
        atSeam = false;
      }
    }
    if (atSeam) {
      // A marker line was removed; swallow the following blank line(s) only when the emitted
      // text already ends blank, so stripping never leaves double blank lines.
      if (emittedTail === '' || emittedTail.endsWith('\n\n')) {
        while (text.startsWith('\n')) text = text.slice(1);
      }
      if (text !== '') atSeam = false;
    }
    lastSourceChar = source.slice(-1);
    if (text !== '') emittedTail = (emittedTail + text).slice(-2);
    return text;
  };

  return {
    push(chunk: string): string {
      const buffer = held + chunk;
      held = '';
      let out = '';
      let cursor = 0;

      for (const span of scanMarkerSpans(buffer)) {
        const between = buffer.slice(cursor, span.start);
        if (between === '' && pendingLineBreak) {
          // Next source char is the marker's '<': the previous marker was not alone on its line.
          pendingLineBreak = false;
          atSeam = false;
        }
        out += emit(between);
        const atLineStart =
          span.start > 0
            ? buffer[span.start - 1] === '\n'
            : lastSourceChar === '' || lastSourceChar === '\n';
        cursor = span.end;
        lastSourceChar = '>';
        if (atLineStart) {
          if (cursor >= buffer.length) {
            pendingLineBreak = true;
          } else if (buffer[cursor] === '\n') {
            cursor += 1;
            lastSourceChar = '\n';
            atSeam = true;
          }
        }
      }

      const tail = buffer.slice(cursor);
      // Hold only viable candidates — nothing after the prefix yet, or '{' next — mirroring
      // scanMarkerSpans' dead-prefix rule, so prose mentioning '<!-- Q:' is released immediately.
      let holdStart = -1;
      let from = tail.length;
      while (from > 0) {
        const candidate = tail.lastIndexOf(MARKER_PREFIX, from - 1);
        if (candidate === -1) break;
        const after = candidate + MARKER_PREFIX.length;
        if (after >= tail.length || tail[after] === '{') {
          holdStart = candidate;
          break;
        }
        from = candidate;
      }
      if (holdStart === -1) {
        holdStart = tail.length;
        for (let len = MARKER_PREFIX.length - 1; len >= 1; len--) {
          if (tail.endsWith(MARKER_PREFIX.slice(0, len))) {
            holdStart = tail.length - len;
            break;
          }
        }
      }
      out += emit(tail.slice(0, holdStart));
      held = tail.slice(holdStart);
      if (held.length > HOLD_CAP) {
        out += emit(held);
        held = '';
      }
      return out;
    },
    flush(): string {
      const out = held;
      held = '';
      pendingLineBreak = false;
      atSeam = false;
      return out;
    },
  };
}
