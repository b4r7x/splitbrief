export type StreamMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
