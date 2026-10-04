import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { parseAntigravityLine } from '../../streaming/parse-antigravity.js';
import type { CliProtocolEvent } from '../../runners/cli-tools/contract.js';
import { cursorProtocolEvents } from '../../runners/cli-tools/cursor.js';
import { kiloImplementerProtocolEvents } from '../../runners/cli-tools/kilo-code.js';
import { opencodeProtocolEvents } from '../../runners/cli-tools/opencode.js';
import {
  createIsolationBoundary,
  findIsolationBreach,
  formatIsolationBreach,
  isolationToolUseGuard,
  type IsolationBoundary,
} from './boundary.js';

const FIXTURES = join(import.meta.dirname, '../../../../testing/fixtures');
const ARTIFACTS = join(import.meta.dirname, '../../../../.test-artifacts');
const ENV_PATH = '/usr/local/bin:/usr/bin:/bin';

function fixtureToolUses(
  file: string,
  parse: (line: string) => readonly CliProtocolEvent[],
): Extract<CliProtocolEvent, { type: 'tool-use' }>[] {
  return readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => parse(line))
    .filter((event) => event.type === 'tool-use');
}

function breachOf(boundary: IsolationBoundary, name: string, input: Record<string, unknown>) {
  const breach = findIsolationBreach(boundary, { name, input });
  return breach === null ? null : formatIsolationBreach(breach);
}

function loggingGuard(boundary: IsolationBoundary) {
  const reads: string[] = [];
  const guard = isolationToolUseGuard(boundary, {
    onOutsideRead: (breach) => reads.push(formatIsolationBreach(breach)),
  });
  return { guard, reads };
}

describe('isolation boundary on the 2026-09-23 antigravity trail', () => {
  // The run's worktree and checkout. agy's `run_command` names no directory, so its commands
  // read from the worktree.
  const boundaryFor = (tool: CliToolId) =>
    createIsolationBoundary({
      isolationDir: '/Users/dev/.local/state/splitbrief/trees/5b1e0c7d2a94/run-7',
      checkoutDir: '/Users/dev/Projects/splitbrief',
      env: { HOME: '/Users/dev', PATH: ENV_PATH },
      tool,
    });
  const boundary = boundaryFor('antigravity');

  it('lets agy look around the worktree its commands run in', () => {
    expect(breachOf(boundary, 'run_command', { CommandLine: 'pwd' })).toBeNull();
    expect(breachOf(boundary, 'run_command', { CommandLine: 'ls -la' })).toBeNull();
  });

  it('carries a cd into the next tool call only for Claude Code, whose shell keeps it', () => {
    const claude = loggingGuard(boundaryFor('claude-code')).guard;
    expect(claude({ name: 'Bash', input: { command: 'cd packages/core && npm test' } })).toBeNull();
    expect(claude({ name: 'Bash', input: { command: 'touch ../shared/src/types.ts' } })).toBeNull();
    const agy = loggingGuard(boundaryFor('antigravity')).guard;
    expect(
      agy({ name: 'run_command', input: { CommandLine: 'cd packages/core && npm test' } }),
    ).toBeNull();
    expect(
      agy({ name: 'run_command', input: { CommandLine: 'touch ../shared/src/types.ts' } }),
    ).toEqual({
      code: 'implementer-left-isolation',
      message:
        'wrote to ~/.local/state/splitbrief/trees/5b1e0c7d2a94/shared/src/types.ts with run_command: touch ../shared/src/types.ts',
    });
  });

  it('stops the home-wide find and the projects-wide grep', () => {
    expect(
      breachOf(boundary, 'run_command', {
        CommandLine: 'find /Users/dev -name "process-invoke.ts" 2>/dev/null',
      }),
    ).toBe('searched ~ with run_command: find ~ -name "process-invoke.ts" 2>/dev/null');
    expect(
      breachOf(boundary, 'run_command', {
        CommandLine: `grep -rn '"name": "splitbrief"' /Users/dev/Projects/ 2>/dev/null`,
      }),
    ).toBe(
      `searched ~/Projects with run_command: grep -rn '"name": "splitbrief"' ~/Projects/ 2>/dev/null`,
    );
  });

  it('reads `./...` and `..env` as names inside the worktree, not its parent', () => {
    for (const command of ['go test ./...', 'go vet ./...', 'cat ..env.example']) {
      expect(breachOf(boundary, 'run_command', { CommandLine: command }), command).toBeNull();
    }
  });

  it('opens no parent of a PATH entry that is the root or under the home', () => {
    const withLocalBin = createIsolationBoundary({
      isolationDir: '/Users/dev/.local/state/splitbrief/trees/5b1e0c7d2a94/run-7',
      checkoutDir: '/Users/dev/Projects/splitbrief',
      env: { HOME: '/Users/dev', PATH: '/bin:/Users/dev/.local/bin' },
      tool: 'antigravity',
    });
    expect(breachOf(withLocalBin, 'list_dir', { DirectoryPath: '/' })).toBe(
      'listed / with list_dir',
    );
    expect(
      breachOf(withLocalBin, 'run_command', { CommandLine: 'cat ~/.local/share/app/token' }),
    ).toBe('read ~/.local/share/app/token with run_command: cat ~/.local/share/app/token');
    expect(breachOf(withLocalBin, 'run_command', { CommandLine: 'ls ~/.local/bin' })).toBeNull();
  });

  it('takes an unknown command operand for a path only when it exists', () => {
    for (const command of [
      "npx vitest run -t '/api/users returns 200'",
      'docker run -v "$PWD":/app -w /app node:22 npm test',
      'node dist/index.js --root /srv/www-splitbrief-probe',
    ]) {
      expect(breachOf(boundary, 'run_command', { CommandLine: command }), command).toBeNull();
    }
  });

  it('closes the checkout it promotes into and every other place under the home', () => {
    expect(
      breachOf(boundary, 'view_file', {
        AbsolutePath: '/Users/dev/Projects/splitbrief/src/cli.ts',
      }),
    ).toBe('read ~/Projects/splitbrief/src/cli.ts (your checkout) with view_file');
    expect(breachOf(boundary, 'list_dir', { DirectoryPath: '/Users/dev' })).toBe(
      'listed ~ with list_dir',
    );
    expect(breachOf(boundary, 'run_command', { CommandLine: 'cat ~/.ssh/id_ed25519' })).toBe(
      'read ~/.ssh/id_ed25519 with run_command: cat ~/.ssh/id_ed25519',
    );
    expect(breachOf(boundary, 'list_dir', { DirectoryPath: '/Users/devel' })).toBe(
      'listed /Users/devel with list_dir',
    );
  });
});

describe("isolation boundary around a tool's own state", () => {
  // agy's own state as it lays it out: `~/.gemini/skills` links into the shared `~/.agents/skills`.
  async function withLinkedSkills(run: (boundary: IsolationBoundary, dir: string) => void) {
    await withTempDir('splitbrief-isolation-tool-state', async (dir) => {
      const home = join(dir, 'home');
      mkdirSync(join(home, '.agents', 'skills', 'x'), { recursive: true });
      mkdirSync(join(home, '.agents', 'library'), { recursive: true });
      mkdirSync(join(home, '.gemini', 'config', 'skills'), { recursive: true });
      writeFileSync(join(home, '.agents', 'skills', 'x', 'SKILL.md'), '# x\n');
      writeFileSync(join(home, '.agents', 'library', 'y.md'), '# y\n');
      symlinkSync(join('..', '.agents', 'skills'), join(home, '.gemini', 'skills'), 'dir');
      mkdirSync(join(dir, 'checkout'));
      mkdirSync(join(dir, 'worktree'));
      run(
        createIsolationBoundary({
          isolationDir: join(dir, 'worktree'),
          checkoutDir: join(dir, 'checkout'),
          env: { HOME: home, PATH: ENV_PATH },
          tool: 'antigravity',
        }),
        dir,
      );
    });
  }

  it('reads through the links in its state and the shared skills, and writes through none', async () => {
    await withLinkedSkills((boundary) => {
      expect(
        breachOf(boundary, 'view_file', { AbsolutePath: '~/.gemini/skills/x/SKILL.md' }),
      ).toBeNull();
      expect(
        breachOf(boundary, 'list_dir', { DirectoryPath: '~/.gemini/config/skills' }),
      ).toBeNull();
      expect(
        breachOf(boundary, 'view_file', { AbsolutePath: '~/.agents/library/y.md' }),
      ).toBeNull();
      expect(
        breachOf(boundary, 'write_to_file', { TargetFile: '~/.gemini/skills/x/SKILL.md' }),
      ).toBe('wrote to ~/.gemini/skills/x/SKILL.md with write_to_file');
    });
  });

  it('loads a skill its state links into the checkout, and still stops the checkout by name', async () => {
    await withLinkedSkills((boundary, dir) => {
      const skill = join(dir, 'checkout', 'skills', 'splitbrief');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '# splitbrief\n');
      symlinkSync(skill, join(dir, 'home', '.gemini', 'config', 'skills', 'splitbrief'), 'dir');
      expect(
        breachOf(boundary, 'view_file', {
          AbsolutePath: '~/.gemini/config/skills/splitbrief/SKILL.md',
        }),
      ).toBeNull();
      expect(breachOf(boundary, 'view_file', { AbsolutePath: join(skill, 'SKILL.md') })).toBe(
        `read ${join(skill, 'SKILL.md')} (your checkout) with view_file`,
      );
    });
  });
});

describe("isolation boundary around the run's attached skills", () => {
  // A skill under another tool's home: codex's own state is `~/.codex`, so `~/.claude` is closed.
  // The home lives outside the temp directories, which the boundary leaves open to every tool.
  async function withAttachedSkill(
    run: (input: {
      home: string;
      skill: string;
      checkout: string;
      boundaryFor: (skillRoots?: readonly string[]) => IsolationBoundary;
    }) => void,
  ) {
    mkdirSync(ARTIFACTS, { recursive: true });
    const dir = mkdtempSync(join(ARTIFACTS, 'isolation-skills-'));
    try {
      const home = join(dir, 'home');
      const skill = join(home, '.claude', 'skills', 'auth');
      mkdirSync(join(skill, 'references'), { recursive: true });
      writeFileSync(join(skill, 'references', 'api.md'), '# api\n');
      mkdirSync(join(home, '.claude', 'skills', 'other'), { recursive: true });
      writeFileSync(join(home, '.claude', 'skills', 'other', 'SKILL.md'), '# other\n');
      mkdirSync(join(dir, 'checkout'));
      mkdirSync(join(dir, 'worktree'));
      run({
        home,
        skill,
        checkout: join(dir, 'checkout'),
        boundaryFor: (skillRoots) =>
          createIsolationBoundary({
            isolationDir: join(dir, 'worktree'),
            checkoutDir: join(dir, 'checkout'),
            env: { HOME: home, PATH: ENV_PATH },
            tool: 'codex',
            ...(skillRoots !== undefined && { skillRoots }),
          }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads what an attached skill lists, and still halts a write there', async () => {
    await withAttachedSkill(({ home, skill, boundaryFor }) => {
      const reference = join(skill, 'references', 'api.md');
      expect(breachOf(boundaryFor(), 'view_file', { AbsolutePath: reference })).toBe(
        'read ~/.claude/skills/auth/references/api.md with view_file',
      );

      const boundary = boundaryFor([skill]);
      expect(breachOf(boundary, 'view_file', { AbsolutePath: reference })).toBeNull();
      expect(
        breachOf(boundary, 'list_dir', { DirectoryPath: join(skill, 'references') }),
      ).toBeNull();
      expect(breachOf(boundary, 'write_to_file', { TargetFile: reference })).toBe(
        'wrote to ~/.claude/skills/auth/references/api.md with write_to_file',
      );
      expect(
        breachOf(boundary, 'view_file', {
          AbsolutePath: join(home, '.claude', 'skills', 'other', 'SKILL.md'),
        }),
      ).toBe('read ~/.claude/skills/other/SKILL.md with view_file');
    });
  });

  it('opens an ignored skill in the checkout to reads, while the rest of the checkout stays closed', async () => {
    await withAttachedSkill(({ checkout, boundaryFor }) => {
      const skill = join(checkout, '.splitbrief', 'skills', 'ignored');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '# ignored\n');
      writeFileSync(join(checkout, 'app.ts'), 'export {};\n');
      const boundary = boundaryFor([skill]);

      expect(breachOf(boundary, 'view_file', { AbsolutePath: join(skill, 'SKILL.md') })).toBeNull();
      expect(breachOf(boundary, 'write_to_file', { TargetFile: join(skill, 'SKILL.md') })).toMatch(
        /^wrote to \S+\/checkout\/\.splitbrief\/skills\/ignored\/SKILL\.md \(your checkout\) with write_to_file$/,
      );
      expect(breachOf(boundary, 'view_file', { AbsolutePath: join(checkout, 'app.ts') })).toMatch(
        /^read \S+\/checkout\/app\.ts \(your checkout\) with view_file$/,
      );
    });
  });
});

describe('isolation boundary on the committed stream fixtures', () => {
  // Every fixture was captured from a probe project at /tmp/probe with HOME=/home/probe.
  const cases: [CliToolId, string, (line: string) => readonly CliProtocolEvent[]][] = [
    ['antigravity', 'antigravity/stream-json.ndjson', parseAntigravityLine],
    ['antigravity', 'antigravity/stream-json-long.ndjson', parseAntigravityLine],
    ['cursor', 'cursor/stream-json-tool-call.ndjson', cursorProtocolEvents],
    ['cursor', 'cursor/stream-json-narrated-verdict.ndjson', cursorProtocolEvents],
    ['kilo-code', 'kilo/stream-json.ndjson', kiloImplementerProtocolEvents],
    ['opencode', 'opencode/stream-json.ndjson', opencodeProtocolEvents],
  ];

  it.each(cases)('lets every %s tool use in %s through', (tool, file, parse) => {
    const boundary = createIsolationBoundary({
      isolationDir: '/tmp/probe',
      checkoutDir: '/srv/checkouts/probe',
      env: { HOME: '/home/probe', PATH: ENV_PATH },
      tool,
    });
    const toolUses = fixtureToolUses(file, parse);
    expect(toolUses.length).toBeGreaterThan(0);
    for (const toolUse of toolUses) expect(findIsolationBreach(boundary, toolUse)).toBeNull();
  });
});

describe('isolation boundary around a linked node_modules', () => {
  async function withLinkedWorktree(run: (boundary: IsolationBoundary, dir: string) => void) {
    await withTempDir('splitbrief-isolation-boundary', async (dir) => {
      const checkout = join(dir, 'checkout');
      const worktree = join(dir, 'worktree');
      mkdirSync(join(checkout, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(checkout, 'src'), { recursive: true });
      writeFileSync(join(checkout, 'node_modules', 'pkg', 'package.json'), '{}');
      mkdirSync(join(worktree, 'src'), { recursive: true });
      symlinkSync(join(checkout, 'node_modules'), join(worktree, 'node_modules'), 'dir');
      run(
        createIsolationBoundary({
          isolationDir: worktree,
          checkoutDir: checkout,
          env: { HOME: '/home/probe', PATH: ENV_PATH },
          tool: 'claude-code',
        }),
        dir,
      );
    });
  }

  it('lets the brief build, test and read its dependencies', async () => {
    await withLinkedWorktree((boundary) => {
      for (const command of [
        'npm test',
        'npx tsc --noEmit',
        'npx vitest run src/a.test.ts',
        'cat src/a.ts',
        'cat node_modules/pkg/package.json',
        'ls node_modules/.bin',
        'npm run lint 2>&1 | tail -20',
        'mkdir -p /tmp/splitbrief-probe && cat /etc/hosts > /dev/null',
        'ls /usr/local/bin',
        'rm -rf node_modules',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toBeNull();
      }
    });
  });

  it('reads the command a shell keyword or a glob would hide', async () => {
    await withLinkedWorktree((boundary) => {
      for (const command of [
        'if [ ! -d node_modules/zod ]; then npm install zod; fi',
        '{ npm install zod; }',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toContain(
          'ran a package-manager command with Bash',
        );
      }
      for (const command of [
        'for f in a b; do sed -i "" s/a/b/ node_modules/pkg/$f.js; done',
        'rm -rf node_modules/*',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toContain(
          "(your checkout's node_modules)",
        );
      }
    });
  });

  it('keeps the directory a cd left the shell in for the next tool call', async () => {
    await withLinkedWorktree((boundary, dir) => {
      mkdirSync(join(dir, 'worktree', 'packages', 'core'), { recursive: true });
      mkdirSync(join(dir, 'worktree', 'packages', 'shared', 'src'), { recursive: true });
      const { guard } = loggingGuard(boundary);
      expect(
        guard({ name: 'Bash', input: { command: 'cd packages/core && npm test' } }),
      ).toBeNull();
      expect(
        guard({ name: 'Bash', input: { command: "sed -i '' s/a/b/ ../shared/src/types.ts" } }),
      ).toBeNull();
      expect(
        guard({ name: 'Bash', input: { command: 'touch ../../../checkout/src/a.ts' } }),
      ).toEqual({
        code: 'implementer-left-isolation',
        message: `wrote to ${join(boundary.checkoutDir, 'src', 'a.ts')} (your checkout) with Bash: touch ../../../checkout/src/a.ts`,
      });
    });
  });

  it('keeps the directory a cd out of the isolation directory left the shell in', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const { guard } = loggingGuard(boundary);
      expect(guard({ name: 'Bash', input: { command: `cd ${dir}` } })).toBeNull();
      expect(guard({ name: 'Bash', input: { command: 'touch checkout/src/a.ts' } })).toEqual({
        code: 'implementer-left-isolation',
        message: `wrote to ${join(dir, 'checkout', 'src', 'a.ts')} (your checkout) with Bash: touch checkout/src/a.ts`,
      });
    });
  });

  it('keeps the directory a logged read left the shell in, so a write after it still halts', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const { guard, reads } = loggingGuard(boundary);
      expect(
        guard({ name: 'Bash', input: { command: `cd ${dir} && cat checkout/src/a.ts` } }),
      ).toBeNull();
      expect(reads).toHaveLength(1);
      expect(guard({ name: 'Bash', input: { command: 'touch checkout/src/b.ts' } })).toMatchObject({
        code: 'implementer-left-isolation',
      });
    });
  });

  it('names the path, never the content, of a file tool that crossed', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const file = join(dir, 'checkout', 'src', 'a.ts');
      expect(
        breachOf(boundary, 'Edit', { file_path: file, old_string: 'a', new_string: 'secret' }),
      ).toBe(`wrote to ${file} (your checkout) with Edit`);
    });
  });

  it('stops a write that goes through the link into the checkout', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const dependencies = join(dir, 'checkout', 'node_modules');
      expect(breachOf(boundary, 'Bash', { command: 'echo x > node_modules/pkg/index.js' })).toBe(
        `wrote to ${join(boundary.isolationDir, 'node_modules', 'pkg', 'index.js')} (your checkout's node_modules) with Bash: echo x > node_modules/pkg/index.js`,
      );
      expect(
        breachOf(boundary, 'Write', { file_path: join(dependencies, 'pkg', 'x.js') }),
      ).toContain('wrote to');
    });
  });

  it('halts the package-manager verbs the implementer prompt forbids, and names the way through', async () => {
    await withLinkedWorktree((boundary) => {
      expect(breachOf(boundary, 'Bash', { command: 'npm install lodash' })).toBe(
        "ran a package-manager command with Bash: npm install lodash — a package-manager install, ci, add, remove or update writes to the project's shared node_modules; change the dependencies in the project yourself, then retry",
      );
      for (const command of [
        'npm i',
        'npm ci',
        'npm uninstall lodash',
        'npm un lodash',
        'npm update',
        'npm up lodash',
        'pnpm install',
        'pnpm add -D vitest',
        'pnpm remove lodash',
        'pnpm upgrade',
        'yarn',
        'yarn add zod',
        'yarn remove zod',
        'bun install',
        'bun add zod',
        'bun rm zod',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toContain(
          'ran a package-manager command',
        );
      }
    });
  });

  it('lets package runners, scripts and links run, and caches they write never halt', async () => {
    await withLinkedWorktree((boundary) => {
      // vitest writes node_modules/.vite and tsc a .tsbuildinfo through the link; neither is in the
      // tool call, so the tripwire never sees them.
      for (const command of [
        'npx vitest run',
        'npx tsc -b',
        'npm test',
        'npm run build',
        'npm exec -- eslint .',
        'pnpm exec vitest',
        'yarn test',
        'bun test',
        'npm link',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toBeNull();
      }
    });
  });

  it('lets a command clear a tool cache in node_modules, and stops one that touches what is installed', async () => {
    await withLinkedWorktree((boundary) => {
      for (const command of [
        'rm -rf node_modules/.vite',
        'rm -rf node_modules/.cache',
        'rm -rf node_modules/.vite/deps',
        'rm node_modules/.cache/x/y.json',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toBeNull();
      }
      for (const command of [
        'rm -rf node_modules/.bin',
        'rm -rf node_modules/.bin/tsc',
        'rm -rf node_modules/.pnpm/foo',
        'rm node_modules/.package-lock.json',
        'rm -rf node_modules/react',
        'rm node_modules/react/index.js',
      ]) {
        expect(breachOf(boundary, 'Bash', { command }), command).toContain(
          "(your checkout's node_modules) with Bash",
        );
      }
    });
  });

  it('lets a read through a workspace package link reach the checkout it points into', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const packageDist = join(dir, 'checkout', 'packages', 'core', 'dist');
      mkdirSync(packageDist, { recursive: true });
      writeFileSync(join(packageDist, 'index.d.ts'), 'export {};\n');
      mkdirSync(join(dir, 'checkout', 'node_modules', '@acme'));
      symlinkSync('../../packages/core', join(dir, 'checkout', 'node_modules', '@acme', 'core'));

      const read = 'cat node_modules/@acme/core/dist/index.d.ts';
      expect(breachOf(boundary, 'Bash', { command: read })).toBeNull();
      expect(
        breachOf(boundary, 'Bash', { command: 'echo x > node_modules/@acme/core/dist/index.d.ts' }),
      ).toContain('(your checkout) with Bash');
    });
  });

  it('finds any use of the checkout itself, even a read', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const file = join(dir, 'checkout', 'src', 'a.ts');
      expect(breachOf(boundary, 'Read', { file_path: file })).toBe(
        `read ${file} (your checkout) with Read`,
      );
    });
  });

  it('turns a breach into the call failure the process guard reports', async () => {
    await withLinkedWorktree((boundary) => {
      const { guard } = loggingGuard(boundary);
      expect(guard({ name: 'Bash', input: { command: 'npm test' } })).toBeNull();
      expect(guard({ name: 'Bash', input: { command: 'touch /home/probe/x' } })).toEqual({
        code: 'implementer-left-isolation',
        message: 'wrote to ~/x with Bash: touch ~/x',
      });
    });
  });

  it('a read of the checkout is logged, not a halt', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const file = join(dir, 'checkout', 'src', 'a.ts');
      const { guard, reads } = loggingGuard(boundary);
      expect(
        guard({ name: 'Bash', input: { command: `grep -rn needle ${boundary.checkoutDir}` } }),
      ).toBeNull();
      expect(guard({ name: 'Read', input: { file_path: file } })).toBeNull();
      expect(guard({ name: 'Bash', input: { command: 'ls /home/probe' } })).toBeNull();
      expect(reads).toEqual([
        `searched ${boundary.checkoutDir} (your checkout) with Bash: grep -rn needle ${boundary.checkoutDir}`,
        `read ${file} (your checkout) with Read`,
        'listed ~ with Bash: ls ~',
      ]);
    });
  });

  it('a write outside still halts', async () => {
    await withLinkedWorktree((boundary, dir) => {
      const file = join(dir, 'checkout', 'src', 'a.ts');
      const { guard, reads } = loggingGuard(boundary);
      expect(guard({ name: 'Write', input: { file_path: file, content: 'x' } })).toEqual({
        code: 'implementer-left-isolation',
        message: `wrote to ${file} (your checkout) with Write`,
      });
      expect(
        guard({
          name: 'Bash',
          input: { command: `cat ${file} && touch ${join(dir, 'checkout', 'src', 'b.ts')}` },
        }),
      ).toMatchObject({
        code: 'implementer-left-isolation',
        message: expect.stringMatching(/^wrote to /),
      });
      expect(reads).toEqual([]);
    });
  });

  it('a package install still halts', async () => {
    await withLinkedWorktree((boundary) => {
      const { guard, reads } = loggingGuard(boundary);
      expect(guard({ name: 'Bash', input: { command: 'npm install lodash' } })).toMatchObject({
        code: 'implementer-left-isolation',
        message: expect.stringContaining('ran a package-manager command with Bash'),
      });
      expect(reads).toEqual([]);
    });
  });
});
