# 16. Sessions — resume before you reconstruct

**Claude Code keeps every conversation on disk;** a reboot, a crash or a closed
terminal loses nothing. Resume it rather than rebuilding context or
re-litigating settled decisions:

```sh
claude --continue              # the most recent conversation in this directory
claude --resume                # pick one
claude --resume <session-id>   # a specific one
```

**Never commit transcripts** — they hold whatever was pasted, secrets included;
mirror them to a private backup if a second copy is needed (§13). For long work, still
keep a short dated digest of what was decided and why.
