import type { AttachedInput, Attachment } from '../schemas/attachment.js';

export interface UserMessageInput {
  text: string;
  displayText: string;
  images: Attachment[];
  attachedInputs: AttachedInput[];
}

export function plainUserMessage(text: string): UserMessageInput {
  return { text, displayText: text, images: [], attachedInputs: [] };
}
