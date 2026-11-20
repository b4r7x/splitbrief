import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { mountShowDiffEditor } from '#testing/helpers/show-diff-editor.js';

it.each([
  { editor: 'cursor', code: 0, fullscreen: true },
  { editor: 'cursor', code: 3, fullscreen: true },
  { editor: 'cursor', code: 0, fullscreen: false },
  { editor: 'cursor', code: 3, fullscreen: false },
  { editor: 'open', code: 0, fullscreen: true },
  { editor: 'open', code: 0, fullscreen: false },
  { editor: 'mg', code: 0, fullscreen: true },
  { editor: 'less', code: 0, fullscreen: true },
  { editor: 'less', code: 1, fullscreen: false },
  { editor: 'more', code: 0, fullscreen: true },
] as const)(
  'shows how to return while $editor waits, then restores fullscreen=$fullscreen after exit $code',
  async ({ editor, code, fullscreen }) => {
    const fixture = await mountShowDiffEditor({
      editor,
      exitCode: code,
      fullscreen,
      viewport: { cols: 80, rows: 24 },
    });
    const { child, terminal, screen, rawIo, statePath, before, projectDir, sessionId } = fixture;
    const gui = editor === 'cursor' || editor === 'open';
    const instruction = {
      cursor: 'Close the file to finish viewing.',
      open: 'Quit the editor app to finish viewing.',
      mg: 'Close the file to return.',
      less: 'Press q to return.',
      more: 'Press q to return.',
    }[editor];
    const message = `run.patch open in ${editor}. ${instruction}`;
    try {
      const openingAt = await fixture.openDiff();
      await fixture.waitForRedraw();
      await vi.waitFor(() => {
        expect(fixture.editorStarted(), rawIo()).toBe(true);
        expect(screen(), rawIo().slice(openingAt)).toContain(message);
        expect(terminal.buffer.active.type).toBe(gui && fullscreen ? 'alternate' : 'normal');
      });
      if (gui) expect(screen()).toContain('Ready to apply');
      const args: string[] = JSON.parse(readFileSync(fixture.startedPath, 'utf8'));
      expect(args).toEqual([
        ...fixture.editorArgs,
        realpathSync(join(sessionDir(projectDir, sessionId), 'run.patch')),
      ]);
      expect(readFileSync(args.at(-1) ?? '', 'utf8')).toContain('+hello from the run');
      const openingIo = rawIo().slice(openingAt);
      if (gui) {
        expect(openingIo).not.toContain(terminalSequences.exitAltBuffer);
      } else if (fullscreen) {
        const exitIndex = openingIo.indexOf(terminalSequences.exitAltBuffer);
        expect(exitIndex).toBeGreaterThanOrEqual(0);
        expect(exitIndex).toBeLessThan(openingIo.indexOf(`run.patch open in ${editor}.`));
      }
      expect(fixture.guiEditorStarted()).toBe(false);
      expect(fixture.didExit()).toBe(false);
      fixture.quit();
      await vi.waitFor(() => {
        expect(terminal.buffer.active.type).toBe(fullscreen ? 'alternate' : 'normal');
        expect(screen()).toContain('Ready to apply');
        expect(screen()).not.toContain(instruction);
        if (code !== 0) expect(screen()).toContain(`${editor} exited with code ${code}`);
      });
      expect(readFileSync(statePath, 'utf8')).toBe(before);
      expect(readFileSync(join(projectDir, 'greeting.txt'), 'utf8')).toBe('hello\n');
      child.write('\x03');
      await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
      child.write('\x03');
      await vi.waitFor(() => expect(fixture.didExit(), rawIo()).toBe(true), { timeout: 5_000 });
      expect(await fixture.exited).toMatchObject({ exitCode: 0 });
      expect(terminal.buffer.active.type).toBe('normal');
      if (editor === 'more') {
        // `more` wrote the patch on the shell screen, below the line: nothing of it is erased.
        expect(screen()).toContain(message);
        expect(screen()).toContain('+hello from the run');
      } else {
        expect(screen()).not.toContain(message);
      }
    } finally {
      await fixture.unmount();
    }
  },
);
