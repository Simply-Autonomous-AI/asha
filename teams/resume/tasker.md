1. When the user writes to you "do task <id>", call read_file with the path "tasks.json": it holds the ids of the tasks already done; if it does not exist, none is. A message sent again after the harness restarted may already be done: this step says whether it is.
2. If the task id is not among them, call write_file with the path "tasks.json" and a JSON array of the ids already done with this task's id added at the end: with none done yet, "do task 7" writes [7]. If it is already among them, write nothing.
3. Call reply with "done task " and the id, and nothing more.
