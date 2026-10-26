import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveCallUsageEvidence } from '../orchestrator/summary/call-evidence.js';
import { writeCommandShim } from '#testing/helpers/command-shim.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

const SESSION_ID = '2026-10-13-resumed-calls';

const PROCESS_SCRIPT = `
import { join } from 'node:path';
import { appendEngineEvent } from './src/core/sessions/log-writer.ts';
import { makeConfig } from './testing/helpers/factories/config.ts';
import { makeTask } from './testing/helpers/factories/task.ts';
import { projectRunnerCallEvent } from './src/engine/calls/event-projection.ts';
import { createImplementerCallContext } from './src/engine/implementers/pipeline/call-result.ts';
import { createPlannerCallContext } from './src/engine/planners/call-context.ts';
import { spawnAndCollect } from './src/engine/streaming/spawn-collect.ts';
import { invokeCommandRunner } from './src/engine/runners/command-based.ts';
import { summarize } from './src/engine/planners/summary.ts';
import { streamCompletion } from './src/engine/providers/openai-stream/completion.ts';

const projectDir = process.argv[1];
const ref = { projectDir, sessionId: ${JSON.stringify(SESSION_ID)} };
let sequence = 0;
const onCallEvent = (event) => {
  const projected = projectRunnerCallEvent(event, { phase: 'implementing', sequence: ++sequence });
  if (projected !== null) appendEngineEvent(ref, projected);
};
const command = join(projectDir, 'bin', 'runner');
const invoke = ({ callContext }) => spawnAndCollect({
  command, args: [], cwd: projectDir, stdin: 'brief', callContext, onCallEvent,
});

await invoke({ callContext: createPlannerCallContext({}, 'planner') });
await invoke({ callContext: createPlannerCallContext({}, 'review') });
await invoke({ callContext: createImplementerCallContext({
  config: makeConfig(), taskId: makeTask().id, attempt: 1,
}) });
await spawnAndCollect({ command, args: [], cwd: projectDir, stdin: 'brief', onCallEvent });
await invokeCommandRunner({
  source: { kind: 'config', runner: { command }, env: process.env, notFoundMessage: 'not found' },
  prompt: 'brief', cwd: projectDir, callContext: createPlannerCallContext({}, 'planner'), onCallEvent,
});
await summarize({ invokeOneShot: invoke }, [{ role: 'user', text: 'Summarize the run.' }]);
await streamCompletion({ chat: { completions: { create: async () => (async function* () {
  yield { choices: [{ delta: { content: 'done' }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
})() } } }, 'fixture', [], { temperature: 0, onProgress: () => {}, onCallEvent });
`;

it('keeps every call distinct in the same session after a new process resumes it', async () => {
  await withTempDir('call-id-resume', async (projectDir) => {
    const binDir = join(projectDir, 'bin');
    mkdirSync(binDir);
    writeCommandShim({ dir: binDir, command: 'runner', lines: ['done'] });
    const runProcess = () =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', PROCESS_SCRIPT, projectDir],
        { encoding: 'utf8', timeout: 30_000 },
      );

    runProcess();
    const before = resolveCallUsageEvidence({ projectDir, sessionId: SESSION_ID });
    expect(before).toHaveLength(7);
    expect(before?.slice(0, 2)).toEqual([
      expect.objectContaining({ role: 'planner', callId: expect.stringMatching(/^planner-/) }),
      expect.objectContaining({ role: 'review', callId: expect.stringMatching(/^review-/) }),
    ]);

    runProcess();
    const resumed = resolveCallUsageEvidence({ projectDir, sessionId: SESSION_ID });
    expect(resumed).toHaveLength(14);
    expect(new Set(resumed?.map((call) => call.callId)).size).toBe(14);
    expect(resumed?.slice(0, 7).map((call) => call.callId)).toEqual(
      before?.map((call) => call.callId),
    );
  });
});
