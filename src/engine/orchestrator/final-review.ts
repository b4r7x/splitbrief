import type { OrchestratorCallbacks, PlannerTokenUsage } from '../../types.js';
import { getCurrentDiff } from '../../utils/git.js';
import { readSpecFile } from '../../utils/fs.js';
import { buildFinalReviewPrompt } from '../spec/review-prompts.js';
import { parseStreamLine } from '../claude-stream.js';
import { spawnWithStdin } from '../planners/spawn.js';
import { createTextHandler } from './events.js';

export async function runFinalReview(
  projectDir: string,
  callbacks: OrchestratorCallbacks,
): Promise<{ text: string; usage: PlannerTokenUsage | null }> {
  const diff = await getCurrentDiff(projectDir);
  const spec = readSpecFile(projectDir, 'spec.md') ?? '';
  const prompt = buildFinalReviewPrompt(spec, diff);

  let fullResponse = '';
  let usage: PlannerTokenUsage | null = null;
  const emitText = createTextHandler(callbacks);

  await spawnWithStdin({
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json'],
    cwd: projectDir,
    stdin: prompt,
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
    onLine(line) {
      const parsed = parseStreamLine(line);
      if (parsed.text) {
        if (parsed.isResult) {
          fullResponse = parsed.text;
        } else {
          fullResponse += parsed.text;
          emitText(parsed.text);
        }
      }
      if (parsed.usage) {
        usage = parsed.usage;
      }
    },
  });

  return { text: fullResponse, usage };
}
