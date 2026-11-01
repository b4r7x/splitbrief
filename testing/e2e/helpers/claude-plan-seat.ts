import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';

/** The consult prompt size the fake planner tool refuses as too long. */
export const REFUSED_CHARS = 500_000;

export type PlanSeatRefusal = 'none' | 'oversized' | 'planner-session' | 'every-consult';

/** One line of the call log. */
export type PlanSeatCall = {
  kind: string;
  args: string[];
  resumed: string | null;
  length: number;
  prompt: string;
};

/**
 * Claude Code as the PLAN seat, at a version that takes typed answers natively. The plan call
 * opens the session `planner-session`; every other call that resumes nothing opens
 * `fresh-session`. A refused call ends the way Claude Code refused an oversized prompt live: an
 * `is_error` result that says only "Prompt is too long", and exit 1. Each call is logged to
 * `calls`, one JSON line each (`PlanSeatCall`).
 */
export function installPlannerClaude(
  binDir: string,
  calls: string,
  answers: Readonly<{ plan: unknown; review: unknown; consult: unknown; refusal: PlanSeatRefusal }>,
): void {
  const { plan, review, consult, refusal } = answers;
  writeFakeNodeCli(
    binDir,
    'claude',
    `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 2.1.296');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
const refusal = ${JSON.stringify(refusal)};
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt === -1 ? null : args[resumeAt + 1];
const emit = (entry) => console.log(JSON.stringify(entry));
const answer = (prompt) => {
  const kind = /^# (Final|Task) Implementation Review$/m.test(prompt)
    ? 'review'
    : /^# Consult (on a failing task|continued)$/m.test(prompt)
      ? 'consult'
      : args.includes('--json-schema')
        ? 'plan'
        : 'summary';
  const session = resumed ?? (kind === 'plan' ? 'planner-session' : 'fresh-session');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
    kind,
    args: args.filter((arg) => !arg.startsWith('{')),
    resumed,
    length: prompt.length,
    prompt,
  }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session });
  if (args.includes('--input-format')) {
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
  }
  const refused =
    kind === 'consult' &&
    ((refusal === 'oversized' && prompt.length > ${REFUSED_CHARS}) ||
      (refusal === 'planner-session' && resumed === 'planner-session') ||
      refusal === 'every-consult');
  if (refused) {
    emit({ type: 'result', is_error: true, result: 'Prompt is too long', session_id: session, usage: { input_tokens: 0, output_tokens: 0 } });
    process.exitCode = 1;
    return;
  }
  const typed = kind === 'plan' ? ${JSON.stringify(plan)} : kind === 'consult' ? ${JSON.stringify(consult)} : kind === 'review' ? ${JSON.stringify(review)} : null;
  emit({
    type: 'result',
    session_id: session,
    result: typed === null ? 'Summary complete' : JSON.stringify(typed),
    ...(typed === null ? {} : { structured_output: typed }),
    usage: { input_tokens: 10, output_tokens: 5 },
  });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const content = JSON.parse(line).message.content;
    answer(typeof content === 'string' ? content : JSON.stringify(content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  answer(readFileSync(0, 'utf8'));
}`,
  );
}
