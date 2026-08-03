import { createInterface } from 'node:readline/promises';
import {
  CONFIRM_PHRASE,
  type ApprovalReviewResult,
  type TieredApprovalRequest,
  type TieredApprovalResponse,
} from '../core/approval/types.js';
import type { ArtifactApprovalReview } from '../engine/runners/types.js';
import { stripTerminalControls } from '../utils/display-text.js';

type PromptForLine = (question: string) => Promise<string>;

type CustomRunnerPromptOptions = Readonly<{
  prompt?: PromptForLine | undefined;
  write?: ((text: string) => void) | undefined;
}>;

async function promptForLine(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const eof = Symbol('eof');
  const closed = new Promise<typeof eof>((resolve) => readline.once('close', () => resolve(eof)));
  const answer = await Promise.race([readline.question(question), closed]);
  readline.close();
  return answer === eof ? '' : answer;
}

function deny(reason: string): TieredApprovalResponse {
  return { decision: 'deny', reason };
}

export async function promptCustomRunnerDisclosure(
  input: Readonly<{
    request: TieredApprovalRequest;
    options?: CustomRunnerPromptOptions | undefined;
  }>,
): Promise<TieredApprovalResponse> {
  const prompt = input.options?.prompt ?? promptForLine;
  const write = input.options?.write ?? ((text) => process.stderr.write(text));
  write(`\n${input.request.actionDescription}\n\n`);

  try {
    const phrase = await prompt(`Type ${CONFIRM_PHRASE} to trust this exact configured runner: `);
    if (phrase.trim() !== CONFIRM_PHRASE) return deny('Configured runner trust was not confirmed.');

    const reason = await prompt('Why do you trust this runner? ');
    if (reason.trim().length === 0) return deny('Configured runner trust requires a reason.');
    return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: reason.trim() };
  } catch {
    return deny('Configured runner trust prompt was cancelled.');
  }
}

export async function promptCustomRunnerArtifactApproval(
  input: ArtifactApprovalReview &
    Readonly<{
      options?: CustomRunnerPromptOptions | undefined;
    }>,
): Promise<ApprovalReviewResult> {
  const prompt = input.options?.prompt ?? promptForLine;
  const write = input.options?.write ?? ((text) => process.stderr.write(text));
  try {
    const label = stripTerminalControls(input.label);
    const artifact = stripTerminalControls(input.text);
    write(`\nReview ${label}:\n\n${artifact}\n`);
    const answer = await prompt('Approve this artifact? [y/N] ');
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
      ? { approved: true }
      : { approved: false };
  } catch {
    return { approved: false };
  }
}
