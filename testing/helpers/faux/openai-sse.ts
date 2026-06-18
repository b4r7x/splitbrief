function openAiSseChunks(
  parts: Array<{
    content?: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    finishReason?: string | null;
  }>,
): string {
  const lines: string[] = [];
  for (const [index, p] of parts.entries()) {
    const chunk: Record<string, unknown> = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          delta: { content: p.content ?? '' },
          finish_reason: p.finishReason ?? (index === parts.length - 1 ? 'stop' : null),
        },
      ],
    };
    if (p.usage) chunk.usage = p.usage;
    lines.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

export function makeOpenAiSseResponse(parts: Parameters<typeof openAiSseChunks>[0]): Response {
  return new Response(openAiSseChunks(parts), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
