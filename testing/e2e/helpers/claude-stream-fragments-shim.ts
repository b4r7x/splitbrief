import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { GREET_FILE, MARKER_FILE } from './stop-continue-fixture.js';

export function installClaudeStreamFragmentsShim(bin: string) {
  const plan = {
    result: makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: [GREET_FILE, MARKER_FILE],
          checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
          steps: ['Write the greeting and the run marker.'],
        }),
      ],
    }),
  };
  const review = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFakeNodeCli(
    bin,
    'claude',
    `
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.296'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const emit = entry => console.log(JSON.stringify({ session_id: 'stream-fragments-session', ...entry }));
const finish = prompt => {
  const isReview = prompt.includes('Final Implementation Review');
  const isPlan = args.includes('--json-schema') && !isReview;
  emit({ type: 'system', subtype: 'init' });
  if (args.includes('--input-format')) emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
  if (isPlan) {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-read', name: 'Read', input: {} } } });
    for (const partial_json of ${JSON.stringify(['{"file_path":"src/hello', ' world.ts"}'])}) {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } } });
    }
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-read', content: 'Source read.' }] } });
    emit({ type: 'stream_event', parent_tool_use_id: 'agent-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CLAUDE_FRAGMENT_SUBAGENT_ANSWER' } } });
    emit({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'text', text: 'CLAUDE_FRAGMENT_SUBAGENT_ANSWER' }] } });
  }
  const answer = isPlan ? ${JSON.stringify(plan)} : isReview ? ${JSON.stringify(review)} : 'Summary complete';
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  emit({ type: 'result', result: text, ...(typeof answer === 'string' ? {} : { structured_output: answer }), usage: { input_tokens: 10, output_tokens: 5 } });
};
if (args.includes('--input-format')) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.once('line', line => {
    finish(JSON.parse(line).message.content);
    lines.close();
    process.stdin.destroy();
  });
} else {
  finish(fs.readFileSync(0, 'utf8'));
}
`,
  );
}
