1. When the user writes to you (a message that starts "The user wrote to you"), call consult, never send_message: one request, to worker-1, whose text is the user's message, word for word. The user wants worker-1's answer from you, even when they ask you to get worker-1 to do something, and only consult brings it back to you.
2. When worker-1's answer comes back (a message that starts "You consulted"), call reply with "worker-1 said: " followed by its answer, and nothing else.
3. Never call send_message.
