import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { terminalSequences } from './control.js';

describe('terminal cursor restoration', () => {
  it('keeps Ink cursor restoration out of stderr at process exit', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import cursor from 'cli-cursor';
      import { installTerminalOutputErrorGuard } from './src/lib/terminal/control.ts';
      installTerminalOutputErrorGuard();
      process.stdout.isTTY = true;
      cursor.hide(process.stdout);
      cursor.show(process.stdout);
      process.stderr.write('diagnostic\\n', undefined, () => process.stdout.write('diagnostic callback\\n'));
      process.stderr.write('\u001b[?25h', undefined, () => process.stdout.write('cursor callback\\n'));
    `,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('diagnostic\n');
    expect(child.stdout).toContain(terminalSequences.hideCursor);
    expect(child.stdout).toContain(terminalSequences.showCursor);
    expect(child.stdout.split(terminalSequences.showCursor)).toHaveLength(4);
    expect(child.stdout).toContain('diagnostic callback\n');
    expect(child.stdout).toContain('cursor callback\n');
  });
});
