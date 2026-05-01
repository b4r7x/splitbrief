import { describe, it, expect } from 'vitest';
import { HookEntrySchema } from './hooks.js';

describe('HookEntrySchema', () => {
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

});
