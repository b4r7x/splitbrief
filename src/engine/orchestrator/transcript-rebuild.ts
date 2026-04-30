import { readMessages } from '../../core/sessions/log-reader.js';

export type ResumeMessage = { role: 'user' | 'assistant'; content: string };

export type ResumeContext = {
  messages: ResumeMessage[];
  warning?: 'transcript-unavailable' | undefined;
};

export async function buildResumeContext(
  projectDir: string,
  sessionId: string,
  persistTranscript: boolean,
): Promise<ResumeContext> {
  if (!persistTranscript) {
    return { messages: [], warning: 'transcript-unavailable' };
  }
  const messages: ResumeMessage[] = [];
  for await (const m of readMessages(projectDir, sessionId)) {
    messages.push({ role: m.role, content: m.text });
  }
  return { messages };
}

