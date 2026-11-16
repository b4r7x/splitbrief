import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { SteerMessage, SteerOutcome } from '../../../calls/steering.js';
import type { PendingSteer, SteerTarget, SteeringCall } from './types.js';

const INBOX_POLL_MS = 50;
const MessageResponse = z.object({ data: z.object({ id: z.string().min(1) }) });
const InboxResponse = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

export function closeAdmission(call: SteeringCall): void {
  if (!call.state.accepting) return;
  call.state.accepting = false;
  call.requestsController.abort();
  for (const item of call.pending) item.resolve(item.sent ? 'uncertain' : 'deferred');
  call.pending.clear();
}

function track(call: SteeringCall, task: Promise<void>): void {
  call.work.add(task);
  void task.then(() => call.work.delete(task));
}

async function pollInbox(
  call: SteeringCall,
  target: SteerTarget,
  id: string,
  item: PendingSteer,
): Promise<void> {
  try {
    while (call.state.accepting) {
      const response = await fetch(
        `${target.url}/api/session/${encodeURIComponent(target.sessionId)}/inbox`,
        {
          headers: target.headers,
          signal: call.requestsController.signal,
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        item.resolve('uncertain');
        return;
      }
      const inbox = InboxResponse.parse(await response.json());
      if (!call.state.accepting) return;
      if (!inbox.data.some((entry) => entry.id === id)) {
        const messageResponse = await fetch(
          `${target.url}/api/session/${encodeURIComponent(target.sessionId)}/message/${encodeURIComponent(id)}`,
          { headers: target.headers, signal: call.requestsController.signal },
        );
        if (messageResponse.status !== 200) {
          await messageResponse.body?.cancel();
          item.resolve(messageResponse.status === 404 ? 'deferred' : 'uncertain');
          return;
        }
        const message = MessageResponse.parse(await messageResponse.json());
        if (!call.state.accepting) return;
        item.resolve(message.data.id === id ? 'delivered' : 'uncertain');
        return;
      }
      await delay(INBOX_POLL_MS, undefined, { signal: call.requestsController.signal });
    }
  } catch {
    item.resolve('uncertain');
  } finally {
    call.pending.delete(item);
  }
}

/** Posts one steer after the steers before it, then reads the inbox until the tool takes it. */
export function sendSteer(
  call: SteeringCall,
  target: SteerTarget,
  message: SteerMessage,
): Promise<SteerOutcome> {
  if (message.images !== undefined && message.images.length > 0) return Promise.resolve('deferred');
  if (!call.state.accepting) return Promise.resolve('deferred');
  const delivery = Promise.withResolvers<SteerOutcome>();
  const item = { sent: false, resolve: delivery.resolve };
  call.pending.add(item);
  call.state.admissions = call.state.admissions.then(async () => {
    if (!call.state.accepting) return;
    item.sent = true;
    try {
      const response = await fetch(
        `${target.url}/api/session/${encodeURIComponent(target.sessionId)}/prompt`,
        {
          method: 'POST',
          headers: target.headers,
          body: JSON.stringify({ text: message.text, delivery: 'steer' }),
          signal: call.requestsController.signal,
        },
      );
      if (response.status !== 200) {
        item.resolve('deferred');
        call.pending.delete(item);
        await response.body?.cancel();
        return;
      }
      const admitted = MessageResponse.parse(await response.json());
      if (call.state.accepting) track(call, pollInbox(call, target, admitted.data.id, item));
    } catch {
      item.resolve('uncertain');
      call.pending.delete(item);
    }
  });
  track(call, call.state.admissions);
  return delivery.promise;
}
