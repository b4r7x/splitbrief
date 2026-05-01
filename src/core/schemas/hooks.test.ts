import { describe, it, expect } from 'vitest';
import { HookEntrySchema, HooksConfigSchema } from './hooks.js';

describe('HookEntrySchema', () => {
  it('parses a valid entry with defaults', () => {
    const r = HookEntrySchema.parse({ command: 'prettier' });
    expect(r).toMatchObject({ command: 'prettier', args: [], timeout_ms: 30_000, on_failure: 'warn' });
  });

  it('parses command entry without kind field (backward compat)', () => {
    const r = HookEntrySchema.parse({ command: 'echo' });
    expect(r.kind).toBe('command');
  });

  it('parses command entry with explicit kind: command', () => {
    const r = HookEntrySchema.parse({ kind: 'command', command: 'echo' });
    expect(r.kind).toBe('command');
  });

  it('parses module entry with kind: module', () => {
    const r = HookEntrySchema.parse({ kind: 'module', path: './hook.js' });
    expect(r.kind).toBe('module');
    if (r.kind === 'module') expect(r.path).toBe('./hook.js');
  });

  it('rejects module entry with command field (strict)', () => {
    expect(() => HookEntrySchema.parse({ kind: 'module', path: './x.js', command: 'echo' })).toThrow();
  });

  it('rejects command entry with path field (strict)', () => {
    expect(() => HookEntrySchema.parse({ kind: 'command', command: 'echo', path: './x.js' })).toThrow();
  });

  it('rejects command "sh"', () => {
    expect(() => HookEntrySchema.parse({ command: 'sh' })).toThrow();
  });

  it('rejects command "/bin/bash"', () => {
    expect(() => HookEntrySchema.parse({ command: '/bin/bash' })).toThrow();
  });

  it('rejects timeout over 300_000', () => {
    expect(() => HookEntrySchema.parse({ command: 'x', timeout_ms: 999_999 })).toThrow();
  });

  it('rejects missing command', () => {
    expect(() => HookEntrySchema.parse({ args: ['x'] })).toThrow();
  });

  it('rejects missing path for module entry', () => {
    expect(() => HookEntrySchema.parse({ kind: 'module' })).toThrow();
  });

});

describe('HooksConfigSchema', () => {
  it('parses a config with multiple events and entries', () => {
    const r = HooksConfigSchema.parse({
      pre_task: [{ command: 'prettier' }, { command: 'npx', args: ['--check'] }],
      post_commit: [{ command: 'notify-send', on_failure: 'ignore' }],
      builtin: { 'prettier-on-change': true, 'block-secrets': false },
    });
    expect(r.pre_task).toHaveLength(2);
    expect(r.post_commit?.[0]?.on_failure).toBe('ignore');
    expect(r.builtin?.['prettier-on-change']).toBe(true);
  });

});
