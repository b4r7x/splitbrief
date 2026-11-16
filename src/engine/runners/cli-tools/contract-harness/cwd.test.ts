import { describe, expect, it } from 'vitest';
import { cwdProbePrompt } from './cwd.js';

describe('CLI cwd conformance leg', () => {
  it('asks for a pwd write without naming a directory to work in', () => {
    const prompt = cwdProbePrompt('hello-0123abcd.txt');
    expect(prompt).toContain('pwd > hello-0123abcd.txt');
    expect(prompt).not.toMatch(/\/[a-z]/i);
  });
});
