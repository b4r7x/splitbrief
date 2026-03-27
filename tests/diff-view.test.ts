import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function render(props: {
  file: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  expanded: boolean;
}) {
  const { default: DiffView } = await import('../src/tui/diff-view.js');
  return DiffView(props);
}

function flattenText(el: any): string {
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(flattenText).join('');
  if (el?.props?.children != null) return flattenText(el.props.children);
  return '';
}

describe('DiffView collapsed mode', () => {
  it('shows file name and line counts', async () => {
    const el = await render({ file: 'src/routes/auth.ts', linesAdded: 47, linesRemoved: 0, diff: '', expanded: false });
    const text = flattenText(el);
    assert.ok(text.includes('src/routes/auth.ts'), 'should contain file name');
    assert.ok(text.includes('+47'), 'should contain added count');
    assert.ok(text.includes('-0'), 'should contain removed count');
  });

  it('renders added count in green and removed in red', async () => {
    const el = await render({ file: 'a.ts', linesAdded: 10, linesRemoved: 3, diff: '', expanded: false });
    const children = el.props.children;
    // children is an array of Text elements from the Box
    const greenEl = children.find((c: any) => c?.props?.color === 'green');
    const redEl = children.find((c: any) => c?.props?.color === 'red');
    assert.ok(greenEl, 'should have a green element for additions');
    assert.ok(redEl, 'should have a red element for removals');
    assert.ok(flattenText(greenEl).includes('+10'));
    assert.ok(flattenText(redEl).includes('-3'));
  });
});

describe('DiffView expanded mode', () => {
  it('shows colored diff lines', async () => {
    const diff = '+ const a = 1;\n- const b = 2;\n  const c = 3;';
    const el = await render({ file: 'src/a.ts', linesAdded: 1, linesRemoved: 1, diff, expanded: true });
    // Box > [summary Text, inner Box with diff lines, truncation]
    const innerBox = el.props.children[1];
    const diffLines = innerBox.props.children[0];
    assert.equal(diffLines.length, 3);
    assert.equal(diffLines[0].props.color, 'green');
    assert.equal(diffLines[1].props.color, 'red');
    assert.equal(diffLines[2].props.dimColor, true);
  });

  it('truncates after 50 lines and shows remaining count', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `+ line ${i}`);
    const diff = lines.join('\n');
    const el = await render({ file: 'src/big.ts', linesAdded: 60, linesRemoved: 0, diff, expanded: true });
    const innerBox = el.props.children[1];
    const innerChildren = innerBox.props.children;
    const diffLines = innerChildren[0];
    assert.equal(diffLines.length, 50);
    const truncation = innerChildren[1];
    assert.ok(truncation, 'truncation indicator should exist');
    const truncText = flattenText(truncation);
    assert.ok(truncText.includes('10'), `should mention 10 remaining lines, got: ${truncText}`);
    assert.ok(truncText.includes('more lines'), `should say "more lines", got: ${truncText}`);
  });

  it('handles empty diff', async () => {
    const el = await render({ file: 'src/empty.ts', linesAdded: 0, linesRemoved: 0, diff: '', expanded: true });
    const text = flattenText(el);
    assert.ok(text.includes('src/empty.ts'), 'should show file name');
    // No inner Box with diff lines for empty diff
    assert.ok(!text.includes('more lines'), 'should not have truncation notice');
  });

  it('create-only diff (all + lines) renders all green', async () => {
    const diff = '+ import a from "a";\n+ export default a;';
    const el = await render({ file: 'src/new.ts', linesAdded: 2, linesRemoved: 0, diff, expanded: true });
    const innerBox = el.props.children[1];
    const diffLines = innerBox.props.children[0];
    assert.equal(diffLines.length, 2);
    for (const line of diffLines) {
      assert.equal(line.props.color, 'green', 'all lines should be green for create-only diff');
    }
  });

  it('modify diff shows mix of green and red lines', async () => {
    const diff = '- old line 1\n- old line 2\n+ new line 1\n+ new line 2\n+ new line 3\n  unchanged';
    const el = await render({ file: 'src/mod.ts', linesAdded: 3, linesRemoved: 2, diff, expanded: true });
    const innerBox = el.props.children[1];
    const diffLines = innerBox.props.children[0];
    assert.equal(diffLines.length, 6);
    assert.equal(diffLines[0].props.color, 'red');
    assert.equal(diffLines[1].props.color, 'red');
    assert.equal(diffLines[2].props.color, 'green');
    assert.equal(diffLines[3].props.color, 'green');
    assert.equal(diffLines[4].props.color, 'green');
    assert.equal(diffLines[5].props.dimColor, true);
  });
});
