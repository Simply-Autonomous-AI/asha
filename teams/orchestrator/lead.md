1. When the user writes to you (a message that starts "The user wrote to you"), call list_agents to read what each worker does.
2. Then call consult once, with one request to each worker whose description covers a part of the request, each request holding only the part that worker does, written as an instruction to it.
3. When the answers come back (a message that starts "You consulted"), call reply with the three results, one per line, in the order the user asked for them, and nothing else.
