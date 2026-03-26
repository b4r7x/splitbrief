import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuestionsFromStream, createQuestionAccumulator } from '../src/orchestrator/question-parser.js';

describe('extractQuestionsFromStream', () => {
  it('extracts a single choice question', () => {
    const text = '<!-- Q:{"id":"q1","type":"choice","text":"Which auth?","options":["JWT","Sessions"],"default":0} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q1');
    assert.equal(questions[0].type, 'choice');
    assert.equal(questions[0].text, 'Which auth?');
    assert.deepEqual(questions[0].options, ['JWT', 'Sessions']);
    assert.equal(questions[0].default, 0);
  });

  it('extracts a single input question', () => {
    const text = '<!-- Q:{"id":"q2","type":"input","text":"What is the table name?","default":"users"} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q2');
    assert.equal(questions[0].type, 'input');
    assert.equal(questions[0].text, 'What is the table name?');
    assert.equal(questions[0].default, 'users');
  });

  it('extracts a single confirm question', () => {
    const text = '<!-- Q:{"id":"q3","type":"confirm","text":"Enable SSR?","default":true} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q3');
    assert.equal(questions[0].type, 'confirm');
    assert.equal(questions[0].text, 'Enable SSR?');
    assert.equal(questions[0].default, true);
  });

  it('extracts multiple questions from text', () => {
    const text = [
      'Some text here.',
      '<!-- Q:{"id":"q1","type":"choice","text":"Pick DB","options":["Postgres","MySQL"]} -->',
      'More text.',
      '<!-- Q:{"id":"q2","type":"confirm","text":"Add migrations?"} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 2);
    assert.equal(questions[0].id, 'q1');
    assert.equal(questions[1].id, 'q2');
  });

  it('returns empty array when no questions present', () => {
    const text = 'Just some regular text with no question markers.';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 0);
  });

  it('extracts only questions from mixed text', () => {
    const text = 'Planning phase started.\nAnalyzing codebase...\n<!-- Q:{"id":"q1","type":"input","text":"Module name?"} -->\nContinuing analysis...';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q1');
    assert.equal(questions[0].text, 'Module name?');
  });

  it('silently skips malformed JSON but extracts valid questions', () => {
    const text = [
      '<!-- Q:{not valid json} -->',
      '<!-- Q:{"id":"q1","type":"choice","text":"Valid?","options":["Yes","No"]} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q1');
  });

  it('skips questions missing required fields', () => {
    const text = [
      '<!-- Q:{"type":"choice","text":"No id"} -->',
      '<!-- Q:{"id":"q1","text":"No type"} -->',
      '<!-- Q:{"id":"q2","type":"choice"} -->',
      '<!-- Q:{"id":"q3","type":"input","text":"Valid"} -->',
    ].join('\n');
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q3');
  });

  it('accepts empty options array as valid', () => {
    const text = '<!-- Q:{"id":"q1","type":"choice","text":"Pick one","options":[]} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0].options, []);
  });
});

describe('createQuestionAccumulator', () => {
  it('returns question when complete in one chunk', () => {
    const acc = createQuestionAccumulator();
    const questions = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"OK?"} -->');
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q1');
  });

  it('returns question only after it is complete across chunks', () => {
    const acc = createQuestionAccumulator();
    const first = acc.addChunk('<!-- Q:{"id":"q1"');
    assert.equal(first.length, 0);
    const second = acc.addChunk(',"type":"choice","text":"Which?","options":["A","B"]} -->');
    assert.equal(second.length, 1);
    assert.equal(second[0].id, 'q1');
  });

  it('returns each new question only once across multiple chunks', () => {
    const acc = createQuestionAccumulator();
    const r1 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"First?"} -->');
    assert.equal(r1.length, 1);
    const r2 = acc.addChunk(' some text ');
    assert.equal(r2.length, 0);
    const r3 = acc.addChunk('<!-- Q:{"id":"q2","type":"input","text":"Second?"} -->');
    assert.equal(r3.length, 1);
    assert.equal(r3[0].id, 'q2');
  });

  it('getAll returns all questions found so far', () => {
    const acc = createQuestionAccumulator();
    acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --> <!-- Q:{"id":"q2","type":"input","text":"B?"} -->');
    const all = acc.getAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, 'q1');
    assert.equal(all[1].id, 'q2');
  });

  it('reset clears the buffer and count', () => {
    const acc = createQuestionAccumulator();
    acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    acc.reset();
    const all = acc.getAll();
    assert.equal(all.length, 0);
    const r = acc.addChunk('<!-- Q:{"id":"q2","type":"input","text":"B?"} -->');
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'q2');
  });

  it('deduplicates questions by id', () => {
    const acc = createQuestionAccumulator();
    const r1 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    assert.equal(r1.length, 1);
    const r2 = acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    assert.equal(r2.length, 0);
    const all = acc.getAll();
    assert.equal(all.length, 1);
  });

  it('buffer does not grow unbounded after many chunks', () => {
    const acc = createQuestionAccumulator();
    // Add a question then many text-only chunks
    acc.addChunk('<!-- Q:{"id":"q1","type":"confirm","text":"A?"} -->');
    for (let i = 0; i < 100; i++) {
      acc.addChunk('Some text without any markers. '.repeat(10));
    }
    // Should still work and return the original question
    const all = acc.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'q1');
  });
});

describe('extractQuestionsFromStream — edge cases', () => {
  it('handles nested braces in JSON string values', () => {
    const text = '<!-- Q:{"id":"q1","type":"input","text":"Enter code like { x: 1 }","default":"{}"} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q1');
    assert.equal(questions[0].default, '{}');
  });

  it('handles escaped quotes in JSON string values', () => {
    const text = '<!-- Q:{"id":"q1","type":"input","text":"Say \\"hello\\"","default":"test"} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.ok(questions[0].text.includes('"hello"'));
  });

  it('skips malformed marker with no closing suffix', () => {
    const text = '<!-- Q:{"id":"q1","type":"confirm","text":"A?"} --\n<!-- Q:{"id":"q2","type":"confirm","text":"B?"} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].id, 'q2');
  });

  it('skips marker with unbalanced braces (incomplete JSON)', () => {
    const text = '<!-- Q:{"id":"q1","type":"confirm" -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 0);
  });

  it('handles empty question text', () => {
    const text = '<!-- Q:{"id":"q1","type":"input","text":""} -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].text, '');
  });

  it('handles marker prefix without opening brace', () => {
    const text = '<!-- Q:not json -->';
    const questions = extractQuestionsFromStream(text);
    assert.equal(questions.length, 0);
  });
});
