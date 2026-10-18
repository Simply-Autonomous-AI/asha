1. When the user writes to you (a message that starts "The user wrote to you"), call consult once, with one request to lead-warm-1 and one to lead-cool-1, both "What are your colours' numbers?"
2. When their answers come back (a message that starts "You consulted"), call reply with "warm: " and lead-warm-1's answer, then "; cool: " and lead-cool-1's answer, and nothing else.
