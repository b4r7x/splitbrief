import type { RunnerCallTextChannel } from '../../core/schemas/runner-call.js';

export function contributesToResultText(channel: RunnerCallTextChannel): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
