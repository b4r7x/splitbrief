import type { Attachment } from '../../core/schemas/attachment.js';
import { readImagesAsBase64 } from '../streaming/attachments.js';

type ImagePlacement = 'before-existing' | 'after-existing';

interface AttachImagesOptions<
  TMessage extends { role: string; content: string | TPart[] },
  TPart,
  TImagePart extends TPart,
> {
  images: Attachment[];
  imagePlacement: ImagePlacement;
  mapText: (text: string) => TPart;
  mapImage: (image: { mime: string; data: string }) => TImagePart;
  createUserMessage: (content: TImagePart[]) => TMessage;
}

export async function attachImagesToLastUserMessage<
  TMessage extends { role: string; content: string | TPart[] },
  TPart,
  TImagePart extends TPart,
>(
  messages: TMessage[],
  opts: AttachImagesOptions<TMessage, TPart, TImagePart>,
): Promise<TMessage[]> {
  if (opts.images.length === 0) return messages;
  const imageParts = (await readImagesAsBase64(opts.images)).map(opts.mapImage);
  const out = messages.map((message) => ({ ...message }));

  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!msg || msg.role !== 'user') continue;
    const existing = typeof msg.content === 'string' ? [opts.mapText(msg.content)] : msg.content;
    msg.content =
      opts.imagePlacement === 'before-existing'
        ? [...imageParts, ...existing]
        : [...existing, ...imageParts];
    return out;
  }

  out.push(opts.createUserMessage(imageParts));
  return out;
}
