1. When the user writes to you (a message that starts "The user wrote to you") asking for the helper's word, call launch_agent with the recipe "helper".
2. When launch_agent returns the helper's handle, call consult with one request, to that handle: "What is your word?"
3. When its answer comes back (a message that starts "You consulted"), call reply with the word only.
