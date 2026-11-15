import { describe, expect, it } from 'vitest';
import { questionDefault } from './question.js';

describe('questionDefault', () => {
  it('reads a boolean default as Yes or No', () => {
    expect(
      questionDefault({ id: 'proceed', type: 'confirm', text: 'Proceed?', default: true }),
    ).toBe('Yes');
    expect(questionDefault({ id: 'skip', type: 'confirm', text: 'Skip?', default: false })).toBe(
      'No',
    );
  });

  it('gives a text default back', () => {
    expect(
      questionDefault({
        id: 'seat',
        type: 'choice',
        text: 'Which seat?',
        options: ['Planner', 'Builder'],
        default: 'Builder',
      }),
    ).toBe('Builder');
    expect(
      questionDefault({ id: 'scope', type: 'input', text: 'Which files?', default: 'src/' }),
    ).toBe('src/');
  });

  it('gives undefined when the question has no default', () => {
    expect(
      questionDefault({
        id: 'seat',
        type: 'choice',
        text: 'Which seat?',
        options: ['Planner', 'Builder'],
      }),
    ).toBeUndefined();
    expect(questionDefault({ id: 'scope', type: 'input', text: 'Which files?' })).toBeUndefined();
    expect(questionDefault({ id: 'proceed', type: 'confirm', text: 'Proceed?' })).toBeUndefined();
  });
});
