// A pattern demo's message command as the request the CLI would send for it (docs/plans/portal-scene-chat.md R16):
// the words a demo page's `asha-run` block uses — `to=`, `topic=`, `user=`, `message=`, `conversation=@previous`,
// `posts=`, `tokens=` — mapped by the CLI's own rules (`parseMessageArgs` in src/cli/commands.ts; a test compares the
// two over every demo page). Any other word, a word twice, or a combination the CLI refuses is not mapped: the demo is
// then one the page cannot run, and says which word. Browser-safe: the daemon builds it, the page reads it.

import { present } from './assert-present.js';
import { NAME_PATTERN, budgetOfText, type ConversationRequest } from './protocol.js';

/** The words a demo's message command may use. */
const DEMO_WORDS = ['to', 'topic', 'user', 'message', 'conversation', 'posts', 'tokens'] as const;

/**
 * `args` mapped word by word, or the first word (with its `=`, if it had one) that is not mapped: not a `DEMO_WORDS`
 * word, or repeated.
 */
function collectDemoWords(args: readonly string[]): Map<string, string> | { readonly unmapped: string } {
  const values = new Map<string, string>();
  for (const arg of args) {
    const at = arg.indexOf('=');
    const key = at < 0 ? arg : arg.slice(0, at);
    if (at < 0 || !(DEMO_WORDS as readonly string[]).includes(key) || values.has(key))
      return { unmapped: at < 0 ? arg : `${key}=` };
    values.set(key, arg.slice(at + 1));
  }
  return values;
}

/** An answer to an ask: channel=, user= and message= only (patterns-phase-3 R27). */
function conversationRequest(
  values: ReadonlyMap<string, string>,
  channel: string,
  user: string | undefined,
  conversation: string,
  message: string,
): ConversationRequest | { readonly unmapped: string } {
  const beside = ['to', 'topic', 'posts', 'tokens'].find((k) => values.has(k));
  if (beside !== undefined) return { unmapped: `${beside}= beside conversation=` };
  return { ...(user === undefined ? {} : { user }), channel, conversation, message };
}

/** The request for one message command on `channel`, or the first word that is not mapped. */
export function demoRequest(
  args: readonly string[],
  channel: string,
): ConversationRequest | { readonly unmapped: string } {
  const values = collectDemoWords(args);
  if (!(values instanceof Map)) return values;
  const message = values.get('message');
  if (message === undefined) return { unmapped: 'message= (missing)' };
  const user = values.get('user');
  const conversation = values.get('conversation');
  if (conversation !== undefined) return conversationRequest(values, channel, user, conversation, message);
  const to = values.get('to');
  const topic = values.get('topic');
  if (topic !== undefined && (to !== undefined || !NAME_PATTERN.test(topic))) return { unmapped: 'topic=' };
  const budget = budgetOfText({
    ...(values.has('posts') ? { posts: present(values.get('posts'), 'posts=') } : {}),
    ...(values.has('tokens') ? { tokens: present(values.get('tokens'), 'tokens=') } : {}),
  });
  if (typeof budget === 'string') return { unmapped: values.has('posts') ? 'posts=' : 'tokens=' };
  return {
    ...(user === undefined ? {} : { user }),
    channel,
    ...(to === undefined ? {} : { to }),
    ...(topic === undefined ? {} : { topic }),
    message,
    ...(budget === undefined ? {} : { budget }),
  };
}
