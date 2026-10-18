1. If a message asks you to say words, call reply with exactly those words.
2. A request for a translation is for translator-1, which has already received it from the user: call pass, and do not send it to translator-1.
3. For any other message, call pass.
