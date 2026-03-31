import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../src/utils/diff.js';

describe('computeDiff', () => {
  it('creates file — empty old produces all + lines', () => {
    const result = computeDiff('', 'line1\nline2\nline3');
    assert.equal(result.diff, '+ line1\n+ line2\n+ line3');
    assert.equal(result.linesAdded, 3);
    assert.equal(result.linesRemoved, 0);
  });

  it('deletes file — empty new produces all - lines', () => {
    const result = computeDiff('line1\nline2\nline3', '');
    assert.equal(result.diff, '- line1\n- line2\n- line3');
    assert.equal(result.linesAdded, 0);
    assert.equal(result.linesRemoved, 3);
  });

  it('returns empty diff when both are empty', () => {
    const result = computeDiff('', '');
    assert.equal(result.diff, '');
    assert.equal(result.linesAdded, 0);
    assert.equal(result.linesRemoved, 0);
  });

  it('returns empty diff when content is identical', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const result = computeDiff(content, content);
    assert.equal(result.diff, '');
    assert.equal(result.linesAdded, 0);
    assert.equal(result.linesRemoved, 0);
  });

  it('shows changed lines with - and + and context', () => {
    const old = 'a\nb\nc\nd\ne';
    const now = 'a\nb\nC\nd\ne';
    const result = computeDiff(old, now);
    assert(result.diff.includes('- c'), 'should show removed line');
    assert(result.diff.includes('+ C'), 'should show added line');
    assert(result.diff.includes('  b'), 'should show context before');
    assert(result.diff.includes('  d'), 'should show context after');
    assert.equal(result.linesAdded, 1);
    assert.equal(result.linesRemoved, 1);
  });

  it('limits context to 2 lines around changes', () => {
    const old = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10';
    const now = '1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10';
    const result = computeDiff(old, now);
    const lines = result.diff.split('\n');
    assert(!lines.some(l => l === '  1'), 'line 1 too far from change');
    assert(!lines.some(l => l === '  2'), 'line 2 too far from change');
    assert(lines.some(l => l === '  3'), 'line 3 should be in context');
    assert(lines.some(l => l === '  4'), 'line 4 should be in context');
    assert(lines.some(l => l === '- 5'), 'removed line 5');
    assert(lines.some(l => l === '+ FIVE'), 'added line FIVE');
    assert(lines.some(l => l === '  6'), 'line 6 should be in context');
    assert(lines.some(l => l === '  7'), 'line 7 should be in context');
    assert(!lines.some(l => l === '  8'), 'line 8 too far from change');
    assert.equal(result.linesAdded, 1);
    assert.equal(result.linesRemoved, 1);
  });

  it('handles large file with scattered changes', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const modified = [...lines];
    modified[10] = 'CHANGED10';
    modified[50] = 'CHANGED50';
    modified[90] = 'CHANGED90';

    const result = computeDiff(lines.join('\n'), modified.join('\n'));
    assert(result.diff.includes('- line10'));
    assert(result.diff.includes('+ CHANGED10'));
    assert(result.diff.includes('- line50'));
    assert(result.diff.includes('+ CHANGED50'));
    assert(result.diff.includes('- line90'));
    assert(result.diff.includes('+ CHANGED90'));

    assert(!result.diff.includes('  line0'));
    assert(!result.diff.includes('  line30'));
    assert(!result.diff.includes('  line70'));

    assert.equal(result.linesAdded, 3);
    assert.equal(result.linesRemoved, 3);
  });

  it('handles addition of new lines at end', () => {
    const old = 'a\nb\nc';
    const now = 'a\nb\nc\nd\ne';
    const result = computeDiff(old, now);
    assert(result.diff.includes('+ d'));
    assert(result.diff.includes('+ e'));
    assert.equal(result.linesAdded, 2);
    assert.equal(result.linesRemoved, 0);
  });

  it('handles removal of lines from middle', () => {
    const old = 'a\nb\nc\nd\ne';
    const now = 'a\ne';
    const result = computeDiff(old, now);
    assert(result.diff.includes('- b'));
    assert(result.diff.includes('- c'));
    assert(result.diff.includes('- d'));
    assert.equal(result.linesAdded, 0);
    assert.equal(result.linesRemoved, 3);
  });
});
