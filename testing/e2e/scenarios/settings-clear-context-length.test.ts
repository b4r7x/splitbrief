import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { installCompatibleCliShim } from '#testing/helpers/compatible-cli-shim.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { forwardTerminalReplies } from '../helpers/terminal-replies.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const viewport = { cols: 120, rows: 40 };
const contextLength = '8192';
const commandQuery = 'Add custom command';

it('replaces a saved shell PLAN seat and restores Context length to auto in Settings', async (context) => {
  const result = await withTempDir('settings-clear-context-length', async (dir) => {
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const { sessionStateHome: home } = installCompatibleCliShim({
      directory: binDir,
      tool: 'claude-code',
    });
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(projectDir, '.splitbrief'));
    const configPath = join(projectDir, '.splitbrief', 'config.yaml');
    writeFileSync(
      configPath,
      `version: 3
planner:
  kind: shell
  command: ./plan.sh
  outputFormat: text
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  model: qwen2.5-coder:7b
  apiBase: http://localhost:11434/v1
  contextLength: ${contextLength}
`,
    );
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Network disabled in replay'); };\n",
    );

    return runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: ['--import', offlinePath, 'dist/cli.js', '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          ...viewport,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...safeChildEnvironment(home, [binDir]), XDG_STATE_HOME: join(dir, 'state') },
        },
      },
      async (child) => {
        const terminal = new XtermHeadless.Terminal({
          ...viewport,
          allowProposedApi: true,
          logLevel: 'off',
        });
        const text = () =>
          Array.from(
            { length: viewport.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          ).join('\n');
        const shows = (line: RegExp) =>
          vi.waitFor(() => expect(text()).toMatch(line), { timeout: 10_000 });
        const exited = Promise.withResolvers<PtyExitEvent>();
        const frames = wholeFrames((data) => terminal.write(data));
        const replies = forwardTerminalReplies(terminal, child);
        const data = child.onData(frames.feed);
        const exit = child.onExit((event) => {
          frames.flush();
          exited.resolve(event);
        });
        try {
          await shows(/Describe your feature/);

          child.write('\x0b');
          await shows(/Type a command/);
          child.write(commandQuery);
          await shows(/› Add custom command/);
          expect(text()).toContain('No matching commands');
          child.write('\x7f'.repeat(commandQuery.length));
          await shows(/Type a command/);
          child.write('crew');
          await shows(/▌ \/crew/);
          child.write('\r');
          await shows(/│ › \/crew\s+│/);
          child.write('plan');
          await shows(/› \/crew plan/);
          child.write('\r');
          await shows(/PLAN · tool, model, effort/);
          expect.soft(text()).not.toContain('+ Add custom command');
          expect(text()).toMatch(/▌ output · \.\/plan\.sh +✓/);
          child.write('claude');
          await shows(/▌ Claude Code CLI/);
          child.write('\r');
          await shows(/▌ auto\b/);
          child.write('\r');
          await vi.waitFor(() => {
            expect(loadConfig(projectDir).config.planner).toEqual({
              kind: 'cli',
              tool: 'claude-code',
              model: 'auto',
            });
          });
          expect(readFileSync(configPath, 'utf8')).not.toMatch(/command:|output_?[fF]ormat/);

          await shows(/Describe your feature/);
          child.write('/settings');
          await shows(/▌ \/settings/);
          child.write('\r');
          await shows(/Settings/);
          child.write('context');
          await shows(/Context length +8192\b/);
          child.write('\r');
          await shows(/Context length +\[8192/);
          child.write('\x7f'.repeat(contextLength.length));
          await shows(/Context length +\[[^\d\n]?\]/);
          child.write('\r');

          await vi.waitFor(
            () => expect(text()).toMatch(/Context length +auto\b|Invalid Context length/),
            { timeout: 10_000 },
          );
          expect(text()).toMatch(/Context length +auto\b/);
          expect(loadConfig(projectDir).config.implementer.contextLength).toBeUndefined();
        } finally {
          try {
            await terminatePtyProcessGroup(child, exited.promise);
          } finally {
            data.dispose();
            exit.dispose();
            replies.dispose();
            terminal.dispose();
          }
        }
      },
    );
  });
  if (result?.status === 'skipped') context.skip(result.reason);
});
