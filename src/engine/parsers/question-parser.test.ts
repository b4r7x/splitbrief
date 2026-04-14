import { describe, it, expect } from 'vitest';
import { extractQuestionsFromStream, createQuestionAccumulator } from './question-parser.js';

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
    const text = 'Planning phase started.\nAnalyzing codebase...\n<!-- Q:{"id":"q1","type":"input","text":"Module name?"} -->\nContinuing analysis...';
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q1');
    expect(questions[0]?.text).toBe('Module name?');
  });

  it('silently skips malformed JSON but extracts valid questions', () => {
    const text = [
      '<!-- Q:{not valid json} -->',
      '<!-- Q:{"id":"q1","type":"choice","text":"Valid?","options":["Yes","No"]} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    expect(questions.length).toBe(1);
    expect(questions[0]?.id).toBe('q1');
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
    acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --> <!-- Q:{"id":"q2","type":"input","text":"B?"} -->');
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
    const text = '<!-- Q:{"id":"q1","type":"input","text":"Enter code like { x: 1 }","default":"{}"} -->';
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
    const text = '<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --\n<!-- Q:{"id":"q2","type":"confirm","text":"B?"} -->';
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
