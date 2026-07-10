import { describe, it, expect, vi } from 'vitest';
import {
  extractQuestionsFromStream,
  createQuestionAccumulator,
  createQuestionMarkerStripper,
} from './question.js';

describe('extractQuestionsFromStream', () => {
  it('extracts multiple questions from text', () => {
    const text = [
      'Some text here.',
      '<!-- Q:{"id":"q1","type":"choice","text":"Pick DB","options":["Postgres","MySQL"]} -->',
      'More text.',
      '<!-- Q:{"id":"q2","type":"confirm","text":"Add migrations?"} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(2);
    expect(questions[0]?.id).toBe('q1');
    expect(questions[1]?.id).toBe('q2');
  });

  it('returns empty array when no questions present', () => {
    const text = 'Just some regular text with no question markers.';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(0);
  });

  it('extracts only questions from mixed text', () => {
    const text =
      'Planning phase started.\nAnalyzing codebase...\n<!-- Q:{"id":"q1","type":"input","text":"Module name?"} -->\nContinuing analysis...';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q1');
    expect(questions[0]?.text).toBe('Module name?');
  });

  it('silently skips malformed JSON (emits stderr warning) but extracts valid questions', () => {
    // last-resort: stderr is the observable output for parse-failure warnings
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const text = [
        '<!-- Q:{not valid json} -->',
        '<!-- Q:{"id":"q1","type":"choice","text":"Valid?","options":["Yes","No"]} -->',
      ].join('\n');
      const questions = extractQuestionsFromStream(text);
      expect(questions.length).toBe(1);
      expect(questions[0]?.id).toBe('q1');
      const warned = writeSpy.mock.calls.some(
        ([chunk]) => typeof chunk === 'string' && chunk.includes('question: malformed marker'),
      );
      expect(warned).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('skips questions missing required fields', () => {
    const text = [
      '<!-- Q:{"type":"choice","text":"No id"} -->',
      '<!-- Q:{"id":"q1","text":"No type"} -->',
      '<!-- Q:{"id":"q2","type":"choice"} -->',
      '<!-- Q:{"id":"q3","type":"input","text":"Valid"} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q3');
  });

  it('accepts empty options array as valid', () => {
    const text = '<!-- Q:{"id":"q1","type":"choice","text":"Pick one","options":[]} -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    const q = questions[0];
    expect(q?.type).toBe('choice');
    if (q && q.type === 'choice') {
      expect(q.options).toEqual([]);
    }
  });
});

describe('createQuestionAccumulator', () => {
  it('returns question when complete in one chunk', () => {
    const acc = createQuestionAccumulator();
    const questions = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"OK?"} -->');
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q1');
  });

  it('returns question only after it is complete across chunks', () => {
    const acc = createQuestionAccumulator();
    const first = acc.addChunk('<!-- Q:{"id":"q1"');
    expect(first.length).toBe(0);
    const second = acc.addChunk(',"type":"choice","text":"Which?","options":["A","B"]} -->');
    expect(second.length).toBe(1);
    expect(second[0]?.id).toBe('q1');
  });

  it('returns each new question only once across multiple chunks', () => {
    const acc = createQuestionAccumulator();
    const r1 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"First?"} -->');
    expect(r1.length).toBe(1);
    const r2 = acc.addChunk(' some text ');
    expect(r2.length).toBe(0);
    const r3 = acc.addChunk('<!-- Q:{"id":"q2","type":"input","text":"Second?"} -->');
    expect(r3.length).toBe(1);
    expect(r3[0]?.id).toBe('q2');
  });

  it('getAll returns all questions found so far', () => {
    const acc = createQuestionAccumulator();
    acc.addChunk(
      '<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --> <!-- Q:{"id":"q2","type":"input","text":"B?"} -->',
    );
    const all = acc.getAll();
    expect(all.length).toBe(2);
    expect(all[0]?.id).toBe('q1');
    expect(all[1]?.id).toBe('q2');
  });

  it('fresh accumulator starts clean', () => {
    const acc1 = createQuestionAccumulator();
    acc1.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    const acc2 = createQuestionAccumulator();
    const all = acc2.getAll();
    expect(all.length).toBe(0);
    const r = acc2.addChunk('<!-- Q:{"id":"q2","type":"input","text":"B?"} -->');
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe('q2');
  });

  it('deduplicates questions by id', () => {
    const acc = createQuestionAccumulator();
    const r1 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    expect(r1.length).toBe(1);
    const r2 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    expect(r2.length).toBe(0);
    const all = acc.getAll();
    expect(all.length).toBe(1);
  });

  it('extracts question whose text contains -->, even when a chunk splits after it', () => {
    const acc = createQuestionAccumulator();
    const first = acc.addChunk('<!-- Q:{"id":"q1","type":"input","text":"use arrow --> here"}');
    expect(first.length).toBe(0);
    const second = acc.addChunk(' -->');
    expect(second.length).toBe(1);
    expect(second[0]?.id).toBe('q1');
    expect(second[0]?.text).toBe('use arrow --> here');
  });

  it('buffer does not grow unbounded after many chunks', () => {
    const acc = createQuestionAccumulator();
    acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    for (let i = 0; i < 100; i++) {
      acc.addChunk('Some text without any markers. '.repeat(10));
    }
    const all = acc.getAll();
    expect(all.length).toBe(1);
    expect(all[0]?.id).toBe('q1');
  });
});

describe('extractQuestionsFromStream — edge cases', () => {
  it('handles nested braces in JSON string values', () => {
    const text =
      '<!-- Q:{"id":"q1","type":"input","text":"Enter code like { x: 1 }","default":"{}"} -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q1');
    expect(questions[0]?.default).toBe('{}');
  });

  it('handles escaped quotes in JSON string values', () => {
    const text = '<!-- Q:{"id":"q1","type":"input","text":"Say \\"hello\\"","default":"test"} -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toContain('"hello"');
  });

  it('skips malformed marker with no closing suffix', () => {
    const text =
      '<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --\n<!-- Q:{"id":"q2","type":"confirm","text":"B?"} -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q2');
  });

  it('skips marker with unbalanced braces (incomplete JSON)', () => {
    const text = '<!-- Q:{"id":"q1","type":"confirm" -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(0);
  });

  it('extracts valid marker after malformed marker with unbalanced braces', () => {
    const text = [
      '<!-- Q:{"id":"q1","type":"confirm","text":"broken',
      '<!-- Q:{"id":"q2","type":"input","text":"Valid?"} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q2');
  });

  it('handles empty question text', () => {
    const text = '<!-- Q:{"id":"q1","type":"input","text":""} -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toBe('');
  });

  it('handles marker prefix without opening brace', () => {
    const text = '<!-- Q:not json -->';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(0);
  });
});

describe('createQuestionMarkerStripper', () => {
  const marker = '<!-- Q:{"id":"q1","type":"confirm","text":"Go?"} -->';

  it('strips a complete-marker-only input to the empty string', () => {
    const stripper = createQuestionMarkerStripper();
    expect(stripper.push(marker)).toBe('');
    expect(stripper.flush()).toBe('');
  });

  it.each([
    ['<'],
    ['<!'],
    ['<!-'],
    ['<!--'],
    ['<!-- '],
    ['<!-- Q'],
    ['<!-- Q:'],
  ])('never emits marker text when the stream splits after %j', (prefix) => {
    const stripper = createQuestionMarkerStripper();
    const outputs = [
      stripper.push(`Intro.\n${prefix}`),
      stripper.push(`${marker.slice(prefix.length)}\nOutro.`),
      stripper.flush(),
    ];
    for (const out of outputs) {
      expect(out).not.toContain('<!-- Q:');
    }
    expect(outputs.join('')).toBe('Intro.\nOutro.');
  });

  it('never emits marker text when the stream splits inside the closing suffix', () => {
    const stripper = createQuestionMarkerStripper();
    const cut = marker.length - 2;
    const outputs = [
      stripper.push(`Intro.\n${marker.slice(0, cut)}`),
      stripper.push(`${marker.slice(cut)}\nOutro.`),
      stripper.flush(),
    ];
    for (const out of outputs) {
      expect(out).not.toContain('<!-- Q:');
    }
    expect(outputs.join('')).toBe('Intro.\nOutro.');
  });

  it('passes non-question html comments through unchanged', () => {
    const stripper = createQuestionMarkerStripper();
    const text = 'Note:\n<!-- note -->\nEnd.';
    expect(stripper.push(text) + stripper.flush()).toBe(text);
  });

  it('passes a split non-question comment through unchanged', () => {
    const stripper = createQuestionMarkerStripper();
    const out = stripper.push('See <!-- ') + stripper.push('note --> here.') + stripper.flush();
    expect(out).toBe('See <!-- note --> here.');
  });

  it('emits held text verbatim when the hold cap overflows', () => {
    const stripper = createQuestionMarkerStripper();
    expect(stripper.push('<!-- Q:{"pad":"')).toBe('');
    const filler = 'x'.repeat(17 * 1024);
    expect(stripper.push(filler)).toBe(`<!-- Q:{"pad":"${filler}`);
    expect(stripper.flush()).toBe('');
  });

  it('flush releases held non-marker residue at stream end', () => {
    const stripper = createQuestionMarkerStripper();
    expect(stripper.push('Done <!-- Q:{"id":"q9"')).toBe('Done ');
    expect(stripper.flush()).toBe('<!-- Q:{"id":"q9"');
  });

  it('collapses the blank lines around a stripped marker line', () => {
    const stripper = createQuestionMarkerStripper();
    const out = stripper.push(`Intro.\n\n${marker}\n\nOutro.`) + stripper.flush();
    expect(out).toBe('Intro.\n\nOutro.');
  });

  it('collapses blank lines around a marker split across pushes', () => {
    const stripper = createQuestionMarkerStripper();
    const out =
      stripper.push('Intro.\n\n<!-- Q:{') +
      stripper.push(`${marker.slice(8)}\n\nOutro.`) +
      stripper.flush();
    expect(out).toBe('Intro.\n\nOutro.');
  });

  it('emits the text between multiple markers', () => {
    const stripper = createQuestionMarkerStripper();
    const second = '<!-- Q:{"id":"q2","type":"input","text":"Name?"} -->';
    const out = stripper.push(`A\n${marker}\nB\n${second}\nC`) + stripper.flush();
    expect(out).toBe('A\nB\nC');
  });

  it('releases prose mentioning the marker prefix immediately', () => {
    const stripper = createQuestionMarkerStripper();
    const out = stripper.push('Markers look like `<!-- Q:...` in the raw stream.\n');
    expect(out).toContain('in the raw stream');
  });

  it('releases a dead candidate with a space after the colon without flush', () => {
    const stripper = createQuestionMarkerStripper();
    expect(stripper.push('<!-- Q: {"id":"q1"} -->')).toContain('"id":"q1"');
    expect(stripper.push('more text')).toContain('more text');
  });
});
