import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { GREET_FILE, MARKER_FILE } from './stop-continue-fixture.js';

export function claudePlannerSteerPaths(directory: string, seat: 'plan' | 'review') {
  return {
    started: join(directory, `${seat}-started`),
    finished: join(directory, `${seat}-finished`),
    release: join(directory, `${seat}-release`),
  };
}

const CaptureSchema = z.object({
  kind: z.enum(['call', 'steer', 'finished']),
  seat: z.enum(['plan', 'review', 'summary']),
  pid: z.number(),
  text: z.string().optional(),
  args: z.array(z.string()).optional(),
  beforeFinish: z.boolean().optional(),
});

export function readClaudePlannerSteers(directory: string) {
  const file = join(directory, 'claude-planner-calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => CaptureSchema.parse(JSON.parse(line)));
}

export function installClaudePlannerSteerShim(directory: string, bin: string) {
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
const paths = ${JSON.stringify({ plan: claudePlannerSteerPaths(directory, 'plan'), review: claudePlannerSteerPaths(directory, 'review') })};
const record = entry => fs.appendFileSync(${JSON.stringify(join(directory, 'claude-planner-calls.jsonl'))}, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const emit = entry => console.log(JSON.stringify(entry));
const echo = text => emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } });
let seat;
let first = true;
const finish = () => {
  const answer = seat === 'plan' ? ${JSON.stringify(plan)} : seat === 'review' ? ${JSON.stringify(review)} : 'Summary complete';
  record({ kind: 'finished', seat });
  if (seat !== 'summary') fs.writeFileSync(paths[seat].finished, '');
  emit({ type: 'result', session_id: 'planner-steer-session', result: typeof answer === 'string' ? answer : JSON.stringify(answer), ...(typeof answer === 'string' ? {} : { structured_output: answer }), usage: { input_tokens: 10, output_tokens: 5 } });
};
const begin = text => {
  seat = text.includes('Final Implementation Review') ? 'review' : args.includes('--json-schema') ? 'plan' : 'summary';
  record({ kind: 'call', seat, text, args });
  emit({ type: 'system', subtype: 'init', session_id: 'planner-steer-session' });
  if (args.includes('--input-format')) echo(text);
  if (seat === 'summary') { finish(); return false; }
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: seat + '-tool', name: 'Read', input: { file_path: 'src/greet.ts' } }] } });
  fs.writeFileSync(paths[seat].started, '');
  return true;
};
if (!args.includes('--input-format')) {
  const text = fs.readFileSync(0, 'utf8');
  if (begin(text)) {
    const timer = setInterval(() => {
      if (fs.existsSync(paths[seat].release)) { clearInterval(timer); finish(); }
    }, 10);
  }
} else {
  if (!args.includes('--replay-user-messages')) throw new Error('Expected native steering acknowledgements');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const text = JSON.parse(line).message.content;
    if (first) {
      first = false;
      if (!begin(text)) { lines.close(); process.stdin.destroy(); return; }
      const timer = setInterval(() => {
        if (!fs.existsSync(paths[seat].release)) return;
        clearInterval(timer); finish(); lines.close(); process.stdin.destroy();
      }, 10);
      return;
    }
    record({ kind: 'steer', seat, text, beforeFinish: !fs.existsSync(paths[seat].finished) });
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: seat + '-tool', content: 'done' }] } });
    echo(text);
  });
}
`,
  );
}
