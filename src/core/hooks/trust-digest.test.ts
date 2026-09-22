import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashHooksConfig } from './trust-digest.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-trust-digest-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('hashHooksConfig', () => {
  it('is canonical — key order does not affect hash', () => {
    const a = hashHooksConfig(projectDir, {
      pre_task: [{ command: 'x' }],
      post_task: [{ command: 'y' }],
    });
    const b = hashHooksConfig(projectDir, {
      post_task: [{ command: 'y' }],
      pre_task: [{ command: 'x' }],
    });
    expect(a).toBe(b);
  });

  it('changes when an interpreter-launched command hook script changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "allow" });',
    );
    const cfg = { pre_task: [{ command: 'node', args: ['hooks/check.mjs'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "deny" });',
    );

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('changes when a script referenced in a --flag=path command token changes', () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(join(projectDir, 'hooks', 'rules.js'), 'export const v = 1;\n');
    const cfg = { pre_task: [{ command: 'node', args: ['--import=./hooks/rules.js', 'run'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(join(projectDir, 'hooks', 'rules.js'), 'export const v = 2;\n');

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('changing the referenced package.json script body invalidates the hooks trust receipt (digest differs)', () => {
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { validate: 'echo ok' } }),
    );
    const cfg = { pre_task: [{ command: 'npm', args: ['run', 'validate'] }] };
    const before = hashHooksConfig(projectDir, cfg);

    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ scripts: { validate: 'echo changed' } }),
    );

    expect(hashHooksConfig(projectDir, cfg)).not.toBe(before);
  });

  it('gives two -c hooks that differ only in their script text different digests', () => {
    writeFileSync(join(projectDir, 'x.sh'), 'echo x\n');
    const plain = { pre_task: [{ command: 'sh', args: ['-c', './x.sh'] }] };
    const destructive = { pre_task: [{ command: 'sh', args: ['-c', './x.sh; rm -rf ~'] }] };

    expect(hashHooksConfig(projectDir, destructive)).not.toBe(hashHooksConfig(projectDir, plain));
  });

  it('keeps the digest that existing trust receipts hold for script hooks', () => {
    mkdirSync(join(projectDir, 'hooks'));
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'export default () => ({ kind: "allow" });\n',
    );
    writeFileSync(join(projectDir, 'hooks', 'check.sh'), 'exit 0\n');
    writeFileSync(join(projectDir, 'hooks', 'rules.json'), '{}\n');
    const cfg = {
      pre_task: [
        { command: 'node', args: ['hooks/check.mjs'] },
        { command: './hooks/check.sh', args: ['--rules=./hooks/rules.json'] },
      ],
    };

    expect(hashHooksConfig(projectDir, cfg)).toBe(
      'sha256:15ffb509d73479fe7b403fb12a8f49dc2d4ce42fc269716a8b352b0171384b0c',
    );
  });
});
