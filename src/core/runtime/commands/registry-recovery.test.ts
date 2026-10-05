import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

describe('/redo-task removal', () => {
  it('registers no /redo-task command', () => {
    const names = createRuntimeCommands(makeCtx({})).map((cmd) => cmd.name);
    expect(names).not.toContain('/redo-task');
  });
});
