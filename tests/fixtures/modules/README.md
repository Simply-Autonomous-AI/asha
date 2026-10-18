# Fakes for the reference modules' contract suite

Built by hand on 2026-10-01 from the vendors' documented formats, **not recorded from a live call**: no live call has
been made (the Tavily key and the Bedrock credential are the owner's to enter, and the first live run is opt-in,
extension-modules R6 (b), R19). The first live run replaces each with a recording and notes it here (debt D49).

- `tavily-search.json`: a Tavily `POST /search` answer at `search_depth: basic` with `include_usage: true`, from
  https://docs.tavily.com/documentation/api-reference/endpoint/search (read 2026-10-01). Its second result carries
  an injected instruction (A10, A16).
- `bedrock-chat-stream.txt`, `bedrock-tool-stream.txt`: Bedrock Chat Completions streams (server-sent events, the
  OpenAI chunk format, usage in the last chunk with `stream_options.include_usage`), from
  https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html (read 2026-10-01).

- `codepipeline.json`: CodePipeline's `RetryStageExecution` documented sample request and answer, and its documented
  `StageNotRetryableException` printed as the AWS CLI prints a service error (exit 255), from
  https://docs.aws.amazon.com/codepipeline/latest/APIReference/API_RetryStageExecution.html (read 2026-10-02); the
  sample's request headers, which hold an example access key id, are left out. Used by A25's integration test, whose
  fixture plugin answers from it (D49).

- `r38-base-calls.json`: the calls a daemon with no `modules/` makes for a start, a hello-world launch and one
  message (extension-modules A38 (a)), recorded on 2026-10-02 at the plan's base commit `9cd9ac9` (clean, in a
  detached worktree) by [`tests/helpers/unused-path.ts`](../../helpers/unused-path.ts) copied there (sha256
  `5f6cc81590b6b3a788e1b7c5063e85c5ac36d213505657480918d8a09a22e92a`), through a one-test file that wrote `recordUnusedPath()` as JSON. The same steps at
  `cb9a16a` plus this change recorded the same file byte for byte. *Amended 2026-10-03 by `docs/plans/debt-paydown-2.md` R1:* `pruneImages` added after the start's `reclaim` — every daemon start now prunes asha's old image versions, modules used or not; nothing else in the file changed (its gate run at `8b1589c` differed by that one line).
