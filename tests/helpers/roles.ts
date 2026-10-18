// The role order the pinned Ministral 3 chat template enforces (docs/plans/prompt-prefix.md R6): it raises on a
// system message after the first, and when user messages and assistant messages without tool calls do not
// alternate. Read from the template in Ministral-3-8B-Instruct-2512-Q4_K_M.gguf's header, 2026-09-28.

import { present } from '../../src/shared/assert-present.js';
import type { ChatMessage } from '../../src/shared/protocol.js';

/**
 * Every way `messages` breaks R6, each named with its index; [] when it keeps it: exactly one system message,
 * first; then, counting only user messages and assistant messages without tool calls, alternation starting with
 * a user message; and a tool message only after an assistant message with tool calls or another tool message.
 */
export function roleProblems(messages: readonly ChatMessage[]): string[] {
  const problems: string[] = [];
  if (messages[0]?.role !== 'system') problems.push('0: the first message is not the system message');
  let expected: 'user' | 'assistant' = 'user';
  messages.forEach((m, i) => {
    if (i === 0) return;
    if (m.role === 'system') {
      problems.push(`${String(i)}: a second system message`);
      return;
    }
    if (m.role === 'tool') {
      const before = present(messages[i - 1], `messages[${String(i - 1)}]`);
      const answers = before.role === 'tool' || (before.role === 'assistant' && (before.toolCalls?.length ?? 0) > 0);
      if (!answers) problems.push(`${String(i)}: a tool message after ${before.role} without tool calls`);
      return;
    }
    if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) return;
    if (m.role !== expected) problems.push(`${String(i)}: ${m.role} where ${expected} must come`);
    expected = m.role === 'user' ? 'assistant' : 'user';
  });
  return problems;
}
