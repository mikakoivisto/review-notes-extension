import type { SwMessage, SwReply } from './messages';

export class RpcError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

/** Send a message to the service worker and unwrap the reply. */
export async function callSw<T = unknown>(msg: SwMessage): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(msg)) as SwReply<T> | undefined;
  if (!reply) throw new RpcError('No reply from the extension service worker');
  if (!reply.ok) throw new RpcError(reply.error ?? 'Unknown error', reply.code);
  return reply.data as T;
}
