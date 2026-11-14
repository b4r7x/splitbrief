import { describe, expect, it } from 'vitest';
import { placeholderForMode, promptColorForMode } from './prompt-mode.js';

const theme = { text: 'text', textDim: 'dim', warning: 'warning' };

describe('promptColorForMode', () => {
  it('draws the prompt in the text color in normal mode', () => {
    expect(promptColorForMode('normal', theme)).toBe('text');
  });

  it('dims the prompt in review mode', () => {
    expect(promptColorForMode('review', theme)).toBe('dim');
  });

  it('draws the prompt in the warning color in question mode', () => {
    expect(promptColorForMode('question', theme)).toBe('warning');
  });
});

describe('placeholderForMode', () => {
  it('invites a change in normal mode', () => {
    expect(placeholderForMode({ mode: 'normal', stopping: false })).toBe('Describe a change…');
  });

  it('asks for a comment in review mode', () => {
    expect(placeholderForMode({ mode: 'review', stopping: false })).toBe('Type a comment…');
  });

  it('asks for an answer in question mode', () => {
    expect(placeholderForMode({ mode: 'question', stopping: false })).toBe('Type your answer…');
  });

  it('shows no placeholder while a run stops in normal mode', () => {
    expect(placeholderForMode({ mode: 'normal', stopping: true })).toBe('');
  });

  it('shows the hint over the text of each mode', () => {
    expect(placeholderForMode({ mode: 'review', stopping: true, hint: 'Pick a file' })).toBe(
      'Pick a file',
    );
  });
});
