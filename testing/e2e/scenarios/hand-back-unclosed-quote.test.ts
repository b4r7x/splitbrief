import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const SESSION = '5b0f3c2e-8d41-4a7e-9c6b-2f1e7a9d4c30';
const NARRATION = 'The test pins that first password: "abc stays masked.';
const REPORT = {
  status: 'done',
  filesChanged: [MARKER_FILE, GREET_FILE],
  touchedNotSuggested: [],
  notes: null,
  decisions: [{ what: 'Kept the greeting text', why: 'The brief names it' }],
};
const STDOUT = `${JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: `${NARRATION}\n${JSON.stringify(REPORT)}` }],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
})}\n`;

it('shows the report row when the hand-back prose holds an unclosed quote after a password key', async () => {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
process.stdout.write(${JSON.stringify(STDOUT)});
`,
    { isolation: 'none' },
  );
  try {
    const config = loadConfig(target.projectDir).config;
    if (config.implementer.kind !== 'agent') {
      throw new Error(`Expected agent implementer, got ${config.implementer.kind}`);
    }
    writeConfig(target.projectDir, {
      ...config,
      implementer: { ...config.implementer, outputFormat: 'stream-json' },
    });

    const run = await cli(target, ['start', 'smoke']);
    expect(run.exitCode, run.stderr).toBe(0);

    const sessionIds = readdirSync(sessionsRoot(target.projectDir));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0];
    if (sessionId === undefined) throw new Error('Expected one session directory');

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    const transcript = transcriptText(events);

    expect(transcript).not.toContain('Report  done');
    expect(transcript).toContain(NARRATION);
    for (const absent of [
      '"status":"done"',
      'REDACTED',
      'the implementer report has no "done" or "blocked" status',
    ]) {
      expect(transcript).not.toContain(absent);
      expect(run.stdout).not.toContain(absent);
      expect(run.stderr).not.toContain(absent);
    }
  } finally {
    cleanupTempDir(target.tmpDir);
  }
});
