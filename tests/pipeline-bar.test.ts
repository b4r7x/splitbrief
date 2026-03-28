import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStageIndex } from '../src/tui/pipeline-bar.js';
import type { Phase } from '../src/types.js';

describe('getStageIndex', () => {
  it('idle → index -1, all stages pending', () => {
    assert.equal(getStageIndex('idle'), -1);
  });

  it('researching → index 0, res is current', () => {
    assert.equal(getStageIndex('researching'), 0);
  });

  it('specifying → index 1, res done, spec current', () => {
    assert.equal(getStageIndex('specifying'), 1);
  });

  it('reviewing-spec → index 1, same stage as specifying', () => {
    assert.equal(getStageIndex('reviewing-spec'), 1);
  });

  it('planning → index 2, res/spec done, plan current', () => {
    assert.equal(getStageIndex('planning'), 2);
  });

  it('reviewing-plan → index 2, same stage as planning', () => {
    assert.equal(getStageIndex('reviewing-plan'), 2);
  });

  it('implementing → index 3, res/spec/plan done, impl current', () => {
    assert.equal(getStageIndex('implementing'), 3);
  });

  it('validating-task → index 3, same stage as implementing', () => {
    assert.equal(getStageIndex('validating-task'), 3);
  });

  it('escalating → index 3, same stage as implementing', () => {
    assert.equal(getStageIndex('escalating'), 3);
  });

  it('final-review → index 4, all previous done, rev current', () => {
    assert.equal(getStageIndex('final-review'), 4);
  });

  it('complete → index 5, all stages done', () => {
    assert.equal(getStageIndex('complete'), 5);
  });

  it('every Phase maps to a defined index', () => {
    const phases: Phase[] = [
      'idle', 'researching', 'specifying', 'reviewing-spec',
      'planning', 'reviewing-plan', 'implementing', 'validating-task',
      'escalating', 'final-review', 'complete',
    ];
    for (const phase of phases) {
      const idx = getStageIndex(phase);
      assert.equal(typeof idx, 'number', `${phase} should return a number`);
      assert.ok(idx >= -1 && idx <= 5, `${phase} index ${idx} out of range`);
    }
  });
});
