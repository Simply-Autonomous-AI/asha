---
title: asha CLI Reference
description: Every asha command and flag — syntax, what it does, what goes to stdout and stderr, exit codes, how the CLI finds or starts the daemon, and the environment it reads.
---

# Command line interface

`./asha` is the one command: it posts messages, launches and watches agents, and manages the daemon.

<div class="facts"><span>verified 2026-09-29</span><span>asha 0.1.1</span><span>Node ≥ 22</span><span>code: <a href="../../src/cli/commands.ts">src/cli/commands.ts</a></span></div>

> [!SUMMARY]
> - Build once with `npm install && npm run build`; `./asha` never runs npm.
> - Results go to stdout. stderr carries only what you must see — `✗` errors, `⚠` warnings, and the one `›` line saying which user ID your login name was sent as, when it had to be converted — unless you add `--verbose`, which adds the `›` progress lines and the models' output as they generate it.
> - `--interactive` keeps a session open: type a message per line, `/watch on` for the whole channel, `/quit` or Ctrl-D to leave.
> - Exit `0` success, `1` failure, `2` malformed command line, `130` Ctrl-C in an interactive session.
> - The daemon starts itself when needed and runs until `asha --stop` (`./asha --stop` in a checkout); stop it after a rebuild or `brew upgrade asha`.
> - Walkthrough with real output: the [guide](guide.md); past corrections: [history](history.md).

<style>
  /* Page-local: keep a flag like --launch on one line in the first column. */
  td:first-child code { white-space: nowrap; }
</style>

## Build time and run time {#build-run}

| Stage | Command | What happens |
|---|---|---|
| Build time | `npm install && npm run build` | After any source change; `build` is `rm -rf dist && tsc -p tsconfig.build.json` ([package.json](../../package.json)). |
| Run time | `./asha …` | The [`asha`](../../asha) script follows symlinks and runs `exec node dist/src/cli/main.js "$@"`. Unbuilt, it prints ``asha: not built — run `npm install && npm run build` in <repo> first`` to stderr and exits `1`. |

- [`main.ts`](../../src/cli/main.ts) injects the `CliContext` (streams, `fetch`, spawning, signals, [bounds](#bounds)) into `runCli` in [commands.ts](../../src/cli/commands.ts), which returns the exit code.
- The build fingerprint: 12 hex digits of a sha256 over every `.js` file under `dist/` (`buildFingerprint` in [src/shared/build.ts](../../src/shared/build.ts)).
- Symlink the script onto your PATH to run it anywhere; it uses the first `node` there.

## Synopsis {#synopsis}

`USAGE` in [commands.ts](../../src/cli/commands.ts), as `./asha --help` prints it (re-taken from `USAGE` on 2026-10-02, when `docs/plans/patterns-phase-3.md` added a message's budget; taken from the built `USAGE` itself on 2026-10-02, when `--portal` was added; the module commands were added the same day; captured from the built CLI 2026-09-30 before that).

```
asha — Autonomous Simple Harness for Agents

usage:
  asha [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle> | topic=<topic>]
       [file=<path> ...] [posts=<n>] [tokens=<n>] message=<text>
                   post a message to a channel (default "main"), first
                   bringing the recipe's agent online there if one is named;
                   to= sends it to one agent (e.g. to=hewo-1) instead of
                   everyone, topic= to the agents of a team that subscribe
                   to that topic. posts= and tokens= are its conversation's
                   budget: the agents' messages in it (1 to 32; 32 without
                   it) and their model calls' tokens (1 to 1,000,000; none
                   without it), past which it ends. user= says who you are
                   (e.g. user=alice);
                   without it you are your login name on this Mac, made to
                   fit a user ID (John.Smith is sent as john-smith, and
                   says so). file= attaches a file (repeat it for more, at
                   most 10): every agent on the channel can read it. Prints
                   the replies meant for you, saves the files an agent
                   returns as ./asha-files/<channel>/<name>, and returns
                   once no agent is still working on it
  asha [user=<id>] [channel=<channel>] conversation=<id> message=<text>
                   answer what an agent asked you: the line "? <handle> is
                   waiting for your answer" gives this command, its
                   conversation= filled in
  asha --interactive [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle>]
                   type messages into the channel, one per line, and see the
                   replies. A word in a line that is a file's path (it has a
                   / or starts with ~/; drag a file in to type it) attaches
                   that file. /watch on shows everything on the channel,
                   /watch off only your replies again; /quit or Ctrl-D
                   leaves; Ctrl-C leaves at once (exit 130), abandoning the
                   reply to a message still being worked on
  asha --launch recipe=<recipe> [channel=<channel>]
                   start a new agent for the recipe on a channel (another
                   one, if one is already there) and print its handle
  asha --launch team=<team> [channel=<channel>]
                   start every member of teams/<team>/ on a channel, each
                   under its own name, and print their handles, one a line
  asha --watch [channel=<channel>]
                   print every message on the channel as it happens, until
                   Ctrl-C
  asha --portal [user=<id>]
                   open the portal, asha's web page, in your browser: every
                   command here, a live picture of a channel's agents, and
                   their telemetry; user= says who you are there
  asha --server    run the harness daemon in the foreground
  asha --status    report whether the daemon is running, and its agents
  asha --stop      stop the daemon and every agent it runs
  asha --stop channel=<channel>
                   stop one channel's agents, then every model server no
                   agent still needs; the daemon keeps running
  asha --list-state
                   list what persisted agents and teams have saved: one line
                   per saved asset and per agent's unsaved messages, then the
                   total
  asha --reset-state all | channel=<channel> [name=<name> [team=<team>]] [--yes]
                   remove saved state: everything, a channel's agents and
                   board, or one agent (team= for a team member); all and
                   channel= list what goes and ask you to type reset (--yes
                   when not at a terminal)
  asha --reset-state channel=<channel> [name=<name> [team=<team>]] user=<id> [--yes]
                   erase one user's saved memory from the agents named; files
                   and boards are shared by every user and are kept
  asha --install-module path=<dir> [archive=<file>] [--yes]
                   install a module from a directory (from this repository's
                   modules/, or a separate package): its files, licences and
                   tool descriptions are checked and summarised, and you type
                   yes (--yes when not at a terminal); a command plugin also
                   needs archive=, its release downloaded from the URL its
                   manifest names. Refused while a daemon runs
  asha --uninstall-module id=<id> [--yes]
                   remove an installed module and its secrets. Refused while a
                   daemon runs
  asha --set-secret module=<id> name=<NAME>
                   store a module's secret, read from standard input (pipe it
                   in: pbpaste | asha --set-secret …); prints only its length
  asha --enable-module id=<id> conversation=<usd> day=<usd> month=<usd>
                   turn on a metered module, with what it may spend in one
                   conversation, one day and one month (UTC), each at most its
                   approved cap
  asha --approve id=<id> [--yes]
                   see a held call an agent asked to make, and approve it by
                   typing yes (--yes when not at a terminal): asha then makes
                   exactly that call, once, and the agent tells you what
                   happened
  asha --help      this text

  --verbose        with any command: also print progress on stderr (the
                   steps of bringing an agent online, your message and user
                   ID, each file attached, agents' internal messages and
                   status, the daemon starting on its own) and the models'
                   output as they generate it

asha prints only each command's output on stdout; errors (✗) and warnings (⚠)
always go to stderr. The daemon starts on its own when a message,
--interactive, --launch or --watch needs it.
```

## How arguments are read {#parsing}

`runCli` strips `--verbose` wherever it appears and refuses `--quiet` wherever it appears ([below](#verbose)); `--interactive` anywhere starts a [session](#interactive) with the rest (`parseInteractiveArgs`); then a first `--launch` or `--watch` takes the rest; `--server`, `--status`, `--stop` or `--help` runs only alone; anything else is a message (`parseConversationArgs`).

Arguments are `key=value` (`parseKeyValues`): known keys, once each, non-empty, split at the first `=`. Quote spaces: `message="Please say: Hello World."`.

A malformed line prints the reason and usage to stderr and exits `2`, contacting no daemon (run 2026-09-27):

| Command line | stderr, first line |
|---|---|
| `./asha` | `nothing to do` |
| `./asha recipe=hello-world` | `missing message=` (from the [guide](guide.md#errors)) |
| `./asha message=` | `message= is empty` |
| `./asha message=a message=b` | `message= given twice` |
| `./asha bogus=1 message=x` | `unrecognized argument: bogus=1` |
| `./asha --help extra` | `unrecognized argument: --help` |
| `./asha --launch` or `./asha --launch channel=x` | `--launch takes recipe=<recipe> and optionally channel=<name>` |
| `./asha --watch foo=1` | `--watch takes only channel=<name>` |
| `./asha --quiet message=x` (anywhere) | `--quiet is gone: asha is quiet by default; add --verbose for progress` |
| `./asha --interactive message=x` | `--interactive takes no message=: type each message after it starts` |
| `./asha --interactive file=a.txt` | `✗ file= is for a single message: in --interactive, a path in a line attaches its file` |
| `./asha --interactive --watch` (or `--launch`, `--status`, `--stop`, `--server`, `--help`) | `--interactive cannot be combined with --watch` |

The daemon checks values: a channel matches `^[a-z][a-z0-9-]{0,31}$` (`NAME_PATTERN` in [protocol.ts](../../src/shared/protocol.ts)); a typed `user=` is `user-<n>` or such a name, not ending `-<number>`, not `asha` — the user-ID rule, `userIdProblem` in [protocol.ts](../../src/shared/protocol.ts), which `claimUser` in [src/daemon/channel/index.ts](../../src/daemon/channel/index.ts) applies. The CLI does not check a typed `user=`: `✗ the daemon rejected the message: HTTP 400: {"error":"\"Bob\" cannot be a user ID: a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens"}` (the daemon's JSON body, as printed), exit `1`.

## Commands {#commands}

Functions are in [src/cli/commands.ts](../../src/cli/commands.ts); real output is in the [guide](guide.md).

### Post a message <span class="badge built">built</span> {#message}

```
./asha [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle> | topic=<topic>] [file=<path> ...] [posts=<n>] [tokens=<n>] message=<text> [--verbose]
./asha [user=<id>] [channel=<channel>] conversation=<id> message=<text> [--verbose]
```

| Argument | Meaning |
|---|---|
| `message=` | Required; an `input` that starts a conversation. |
| `channel=` | Default `main` (`DEFAULT_CHANNEL`). |
| `recipe=` | Bring the recipe's agent online first, or reuse one (`› agent: hewo-1 already online on main`). |
| `to=` | One agent (`to=hewo-1`); unknown: `✗ unknown_handle: …`. |
| `topic=` | A topic (`docs/plans/patterns-phase-3.md` R21): the message reaches the agents whose team member subscribes to it (`topics` in `team.json`, [recipes](../architecture/recipes.md#team)), framed as a message to everyone; none subscribed: `✗ unknown_topic: no agent on channel "<channel>" subscribes to topic "<topic>"`, exit 1, nothing posted. With `to=`, or not a name matching `/^[a-z][a-z0-9-]{0,31}$/`, a usage error, exit `2`. |
| `conversation=` | Answer what an agent asked (`docs/plans/patterns-phase-3.md` R25, R27; [asking the user](../architecture/channel.md#asking)): the message goes to the asking agent in that conversation, and the command follows the conversation as for a new message. It takes only `channel=`, `user=` and `message=` — with `recipe=`, `to=`, `topic=`, `file=`, `posts=` or `tokens=` it is a usage error, exit `2`. The line `? <handle> is waiting for your answer: …` gives it whole. A conversation that does not wait for this user's answer — never asked, answered already, its window passed, its agent gone, ended, or another user's — is `✗ not_awaiting: <which>`, exit 1, nothing posted. |
| `posts=` | The conversation's budget of agent posts, a whole number from 1 to 32 (`docs/plans/patterns-phase-3.md` R15); without it, 32. The agent post past it is refused and the conversation ends: `✗ budget_exceeded: conversation <id> reached its budget of <n> agent posts`, exit 1 ([the end of a conversation](../architecture/channel.md#ended)). Any other value is a usage error, exit `2`, as is `posts=` with `--interactive` or `--launch`. |
| `tokens=` | The conversation's budget of model tokens, a whole number from 1 to 1,000,000 (R15, R17); without it, none. Each model call's prompt and completion tokens are counted when it ends; the call that passes the budget ends the conversation: `✗ budget_exceeded: conversation <id> used <t> tokens of its budget of <n>`, exit 1. Refused as `posts=` is. |
| `file=` | Attach a file to the message; repeat it for more, at most 10 (`MAX_FILES_PER_MESSAGE`). A path, relative to the folder `asha` runs in, or starting `~/` for your home folder. Any file that cannot be attached refuses the whole message before anything is sent, exit `1` ([files](#files)). |
| `user=` | Who you are (`user=alice`), sent as typed and checked by the daemon. **Default: your login name on this Mac** (`os.userInfo().username`), converted to fit the user-ID rule — ASCII capitals lowercased, each `.` and `_` made `-`, nothing else changed (`loginNameToUserId`). A name the conversion changed is announced, with or without `--verbose`: `› your login name "John.Smith" is sent as user ID "john-smith"`. A name that still breaks the rule is refused before anything is sent, exit `1`: `✗ your login name "<name>" converts to "<converted>", which cannot be a user ID: <reason>; type user=<id> to choose one` — the reasons are the rule's four (1 to 32 characters of lowercase letters, digits and hyphens starting with a letter; not the issued form `user-<n>`; no other `-<number>` ending; not `asha`); if the name cannot be read, `✗ cannot read your login name: <error>; type user=<id> to choose one`. **Collisions:** names that differ only in case, `.`, `_` or `-` become one ID (`John.Smith`, `john_smith` and `john-smith` are all `john-smith`), and a converted name can equal one someone types (`user=john-smith`); within one home (`ASHA_HOME`) those are the same user, with the same memory, and nothing warns. Your login name is as unverified as a typed name (D2): anyone who runs `asha` can say they are anyone. Every agent on the channel receives the `user` field — including an agent granted a cloud service, which can pass it to that provider (the owner's answer to agent-persistence question 7, record `user-to-cloud`). Only a client of the control API that sends no `user` is issued a `user-<n>` (never reused, `users.json`). |

`converse` sends `POST /v1/conversations` (a `ConversationRequest`) and feeds each `ConversationEvent` of its server-sent event stream to `ConversationTracker`, returning once *settled*: posted, and `working` (agents with unacknowledged deliveries) empty.

Every `›` line below is printed only with [`--verbose`](#verbose); the reply text and the `✗` line are printed always.

| Event | Printed |
|---|---|
| `phase` | `› <phase>: <detail>`, e.g. `› model: qwen3-8b-q4_k_m cached` |
| `announced` | `› <handle>: <text>`, e.g. `› hewo-1: Hi` |
| `posted` | `› olga → main: …`, or `› olga → hewo-1 on main: …` with `to=` (the message's user ID) |
| `message`, kind `status` | `› hewo-1: ok` |
| `message`, kind `internal` | `› internal hewo-1 → hewo-2: …` (`all agents` when to everyone) |
| `message`, kind `output` | `› output hewo-1 → olga:`, then the reply text, **on stdout** |
| `message`, kind `output` carrying `asks` | as any output, then, always, on stderr: `? clerk-1 is waiting for your answer: asha user=olga conversation=<id> message="…"` (`channel=<channel> ` before `user=` when it is not `main`) — the command that answers it ([`conversation=`](#message)) |
| `agent_left` | `› <handle> left the channel: <detail>` |
| `model_delta` | the model's output as it is generated: `› <handle> <part>: ` — `thinking`, `text`, or the tool's name (`reply`) — then each fragment as it arrives, on one line; a new line whenever the call or the part changes ([deltas](#deltas)) |
| `model_done` | ends the open delta line of its call |
| `error` | `✗ <reason>: <detail>`, always |

- Silent: `status` (carries `working`, on every ack); the heartbeat comment resets the idle bound.
- Continuation lines are indented four spaces.
- `error` reasons (`ConversationErrorReason` in [protocol.ts](../../src/shared/protocol.ts)): `bad_request`, `unknown_recipe`, `unknown_team`, `unknown_image`, `prerequisite`, `container_runtime`, `model_fetch`, `model_server`, `image_build`, `agent_start`, `unknown_handle`, `slow_reader` (the CLI fell more than 1 MiB behind the stream, [the streams](../architecture/index.md#apis)), `pending_full` (a persisted agent the message is for holds 32 unsaved deliveries or 4 MiB of them: nothing was posted, [stopping](../architecture/channel.md#stop)), `identity_in_use`, `memory_egress_forbidden`, `state_image_mismatch`, `state_schema_changed`, `persist_mismatch`, `state_inside_git_tree` (the launch refusals of [saved state](#state)), `files_space_in_use` ([files](#files)), `module_refused`, `module_unavailable` ([modules](#modules)), `unknown_topic` (a `topic=` no agent on the channel subscribes to: nothing was posted), `not_awaiting` (a `conversation=` answer the conversation does not wait for: nothing was posted), `budget_exceeded` (the conversation reached its `posts=` or `tokens=` budget, or 32 agent posts) and `restart_limit` (an agent working on it exited more often than its recipe's `restart` allows) — each the harness [ending the conversation](../architecture/channel.md#ended), `docs/plans/patterns-phase-3.md` R13, R16–R18 — `internal`. *(Corrected 2026-10-02: this list left out `files_space_in_use`, `module_refused` and `module_unavailable`, the launch refusals of [files](#files) and [modules](#modules).)*
- A line from the harness itself that opens with `⚠` — `⚠ <handle>'s state is not being saved (<reason>); what it does from now on is lost when it stops`, `⚠ <handle> could not resume an agent's message from before the restart` — is printed on stderr always (`printConversationMessage`, `ConversationTracker`).

#### Files: attaching, and the files an agent returns {#files}

(`docs/plans/agent-files.md` R1–R3a, R7, R8, R12a, R13; the daemon's side is [the channel file space](../architecture/channel.md#files).)

**Every channel has a file space**, `/channel` in each of its agents' containers. A file you attach is copied into it, and **every agent on the channel can read it, and so can every user's agents after you** — a channel's files are shared by everyone on it, as its board is. The agents see the file at `/channel/upload-<16 hex>/<name>`: each upload gets a folder of its own, so a second file of the same name never replaces the first, and two files of one name in one message land as `<name>` and `<name>-2` (a dot keeps its suffix: `a.tar-2.gz`). The message tells each agent, one line per file after its text: `Attached file: /channel/upload-…/notes.txt (120 bytes)`.

**Attaching.** `file=<path>` on a single message ([`--interactive`](#interactive) attaches by a path in a line instead). The CLI reads each file itself — the daemon never opens a path you name — through one open descriptor, after these checks, any failure printed `✗ <path>: <rule>` with exit `1` and nothing sent (`readAttachment` in [src/cli/attach.ts](../../src/cli/attach.ts)):

| Refused | Rule printed |
|---|---|
| a missing or unreadable file, or a link that does not resolve | `no such file`, `cannot be read (EACCES)`, `a link that does not resolve` |
| a folder, a FIFO, a device, a socket | `a directory, not a file`, `not a regular file` |
| a file with a second name (a hard link) | `has more than one name (a hard link)` |
| a file swapped between the check and the open | `changed while it was being opened` |
| over 25,000,000 bytes (`MAX_ATTACHMENT_BYTES`), or one that grew past it while read | `over 25,000,000 bytes` |
| a name the space cannot hold (`/`, a control character, `.` or `..`, over 255 bytes) | the name's rule |
| a path on the **credential deny list** | `on the credential deny list (<entry>)` |
| an eleventh file | `more than 10 files` |
| more than the space can hold: 1,000 entries or 256,000,000 bytes, counted with the upload's folder, by what the daemon reports the space holds now | `channel <channel>'s file space would hold more than …` |

The **credential deny list** (`CREDENTIAL_DENY_LIST` in [src/shared/credentials.ts](../../src/shared/credentials.ts)) is compared on the path with every symbolic link resolved, after Unicode NFC and lower-casing (the Mac's disk ignores case): any path component `.aws`, `.ssh`, `.gnupg`, `.docker`, `.kube`, `.azure`, `.terraform.d`, `.password-store` or `.claude`; anything under `.config/gcloud`, `.config/gh`, `Library/Keychains`, `Library/Cookies`, `Library/Safari`, or the Chrome, Firefox and Microsoft Edge folders of `Library/Application Support`; a file named `credentials`, `credentials.*`, `.git-credentials`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.vault-token`, `.env`, `.env.*`, an SSH key (`id_rsa`, `id_ed25519`, … and their `.pub`), `*.pem`, `*.key`, `*.p12`, `*.pfx` or `*.kdbx`; and anything under `ASHA_HOME`. It matches names and paths only: **a secret written inside any other file is sent like any other text** — except asha's own two secrets, which the daemon refuses in any upload (below). *(Amended 2026-10-02 by `docs/plans/portal.md` R8b, from the owner's answer to its question 6: this said names only, with no exception.)*

**What is sent.** First `POST /v1/channel/space` makes sure the channel's file space exists (with `recipe=`, readying the recipe's image; the agent comes online with the message) and reports what the space holds and which agents on it are cloud-granted; then the files go up in **one streamed upload** (`POST /v1/channel/files`, a manifest line naming each file's name, size and sha256, then the bytes — the CLI never holds a whole file in memory); then the message is posted naming the upload. **The path you typed reaches the agents**: the file's name is in the line they read, and an interactive line is posted as typed, so `/Users/you/Clients/acme/plan.pdf what is this?` tells them that folder's name. The upload is refused whole when the daemon finds a file's bytes differ from what the CLI measured (it changed while being sent): `✗ upload to channel <channel>: 400 sha256_mismatch …`, and nothing of it stays in the space. **It is refused whole too when a file holds asha's own control credential or model-server key**, the daemon searching each file's bytes as they pass (a copy of `daemon.json` made outside `ASHA_HOME`, say): `✗ upload to channel lab: 400 holds_asha_secret: daemon-copy.json holds asha's control credential`, exit `1`, no byte of the value copied, nothing logged that names it ([the upload route](../architecture/index.md#apis); the [portal](../portal/index.md#files) uploads the same way). That check does not catch: any other program's secret; asha's values in another form (upper case, base64, split by a line break, compressed, or inside an archive); the dead credential and model-server key of an earlier daemon run (a crash leaves its `model-server.key` behind); agent tokens; a value typed into a message's text or a file's name; a value split across two files. Other refusals, each `✗ upload to channel <channel>: <status> <reason>: <detail>`, exit `1`: `space_entries`, `space_bytes` (413), `too_many_uploads` (429: a channel holds at most 100 uploads not yet named by a message), `space_busy` (503: another upload held the space for 60 s), `copy_failed`, `copy_timeout`, `rollback_failed`. An upload answers within 260 s or fails `✗ upload to channel <channel>: no answer in 260 s`.

**Seeing what was attached.** With [`--verbose`](#verbose), one line per file on stderr: `attached ./notes.txt as /channel/upload-3f9c…/notes.txt (120 bytes)`. Without it nothing is printed — so a sentence can attach a file you meant only to mention (in an interactive line, a word with a `/` that names an existing file attaches it). Run with `--verbose` to see, or read the daemon log's `files.attached` record, one per file: your user ID, the channel, the agents it reached, and the file's name, size and sha256 — never the path on your Mac or the bytes.

**A cloud-granted agent.** When an agent on the channel, or the recipe being launched, is granted a cloud service, the CLI prints `⚠ <agent> is cloud-granted: files on channel <channel> may leave this machine` before anything is uploaded — always, with or without `--verbose`. A launch of a cloud-granted agent onto a channel whose space already holds files prints the same line. A recipe is cloud-granted when it grants a [module](../architecture/modules.md) that lists a host, or names a hosted model ([what leaves the machine](../architecture/modules.md#memory)). **Every agent on the channel, cloud-granted ones included, receives the `user` field of each message** — by default your login name, converted to fit the user-ID rule — so it can reach a cloud module's vendor (the owner's answer, `user-to-cloud`, 2026-09-27).

**Files an agent returns.** An agent whose recipe selects `reply_with_files` can answer with files from `/channel` ([the tool](../architecture/channel.md#files)). The CLI saves each one as `./asha-files/<channel>/<name>` under the folder `asha` runs in, and prints on stdout, after the reply's text:

```
file: asha-files/lab/summary.txt (812 bytes, sha256 9b1e…)
```

It **never overwrites**: a name already taken — by a file, a folder or a symbolic link — saves as `<name>-2`, `-3`, …, and a link at the name is never followed. The bytes go to a partial file `.asha-partial-<16 hex>`, made new, then checked against the reply's size and sha256 and given its name; a download that ends short, does not match, or stalls 30 s prints `✗ file <name>: <rule>`, exit `1`, and leaves no partial. The folder `asha-files` (and the channel's folder in it) must be a real folder: a symbolic link there is refused. A saved file is mode `0644`. `--watch` and other users never fetch: they see the file's name, size and sha256 only.

**Binary files** attach and return like any other, byte for byte; an agent's `read_file` answers `not_text` for one, so a model reads text files only. **Erasing a user** ([`--reset-state … user=`](#state)) keeps the files they attached and a persisted channel's file table: files are shared by everyone on the channel.

#### The models' output, as it is generated {#deltas}

With `--verbose` the models' output is printed on stderr as it is generated (`DeltaPrinter` in [commands.ts](../../src/cli/commands.ts); since 2026-09-29, `docs/plans/model-streaming.md`). For a forced tool call, which is every agent turn, the fragments are the raw JSON of the call's arguments — for `reply`, its `text` inside JSON quotes and escapes — while stdout gets the reply itself, whole, as without `--verbose`. A delta line is ended before any other line is printed. The deltas include what no message carries: a model's thinking (for a recipe that turns it on, [thinking](../architecture/models.md#thinking)), and drafts the agent's channel layer refused, such as a message to a handle that is not on the channel.

<p class="pre-label">captured 2026-09-29 at <code>aa03619</code> (log (<code>evals/probes/model-streaming-2026-09-29/guide-capture-aa03619.log.txt</code>)); stderr, the login name shown as <code>you</code></p>

```
› you → hewo-1 on duo: Please ask hewo-2 to say Hello World.
› hewo-1 send_message: {"to": "hewo-2", "text": "Say: Hello World"}
› hewo-1: ok
› internal hewo-1 → hewo-2: Say: Hello World
› hewo-2 reply: {"text": "Hello World"}
› hewo-2: ok
› output hewo-2 → you:
```

> [!WARNING] When no agent answers, the command still fails
> Every case exits `1` (`ConversationTracker` in [commands.ts](../../src/cli/commands.ts)):
> - **Normally** the harness posts an `output` from `asha` (`HARNESS_HANDLE`) saying what each agent did, or `No agent on channel "<channel>" received this, so nobody could answer it.`, printed on stdout like a reply, with no `✗` line.
> - **With no reply at all**, not even the harness's: `✗ the conversation ended with no reply at all, not even the harness's: `, then each agent that left (`<handle> left the channel (<detail>); `), then `a defect in the daemon; see its log`, or `the daemon runs a different build than this asha (see asha --status)` when it does.

**Exit** `0` when an agent replied; `1` on the no-answer reply, an `error` event, a non-2xx answer (`✗ the daemon rejected the message: HTTP <status>: <body>`), early close (`✗ the daemon closed the conversation before it settled; see its log`, followed by the socket's reason in parentheses when the daemon stopped mid-stream), 60 s of silence (`✗ no word from the daemon for 60000 ms; see its log`), or no daemon; `2` malformed.

<p class="pre-label">examples, from the <a href="guide.md">guide</a>'s captured runs</p>

```
./asha recipe=hello-world message="Please say: Hello World."      # bring hewo online, ask everyone
./asha user=alice to=hewo-1 message="Please say: Hello World."    # as alice, one agent
./asha to=hewo-1 channel=duo message="Please ask hewo-2 to say Hello World."
reply=$(./asha message="Please say: Hello World.")                 # just the answer
./asha --verbose message="Please say: Hello World."               # and how it got there
```

### `--launch` <span class="badge built">built</span> {#launch}

```
./asha --launch recipe=<recipe> [channel=<channel>] [--verbose]
./asha --launch team=<team> [channel=<channel>] [--verbose]
```

`launch` sends `POST /v1/agents` with `{recipe, channel}` or `{team, channel}` (default `main`), streaming `LaunchEvent`s. **A recipe:** to `launched` or `error`; it always starts a *new* agent (`hewo-1`, then `hewo-2`). Progress, with `--verbose`: `› image: asha-image-hello-world current`, `› hewo-2: Hi`. **A team** (`teams/<team>/`, [team](../architecture/recipes.md#team)): every member in `team.json`'s order, each under its own name, printing each handle on stdout as it comes online, to `team_launched` or `error`. Progress per member, with `--verbose`: `› member supervisor (recipe supervisor)`, then its phases and its `Hi`. Every member's recipe and documents are checked before any container starts, and a member that fails to come online stops the members already started; the error names the member and why, for example `✗ internal: team crew: member "helper" did not start: …/helper.json: document "gone.md" does not exist in the recipe's folder`.

**Exit** `0` launched (every member, for a team); `1` on an `error` event, a non-2xx answer (`✗ the daemon refused the launch: HTTP …`), early close before `launched` (or `team_launched`), 60 s of silence, or no daemon; `2` without exactly one of `recipe=` and `team=`, or with extras.

<p class="pre-label">example, from the <a href="guide.md#two-agents">guide</a></p>

```
./asha --launch recipe=hello-world channel=duo     # stdout: hewo-1
./asha --launch recipe=hello-world channel=duo     # stdout: hewo-2
```

A team launch's real output (the agent suite's `p01-delegation` launch at `7706e6a`, 2026-09-29; the daemon's log path elided):

```text
$ ./asha --verbose --launch team=delegation
› started the asha daemon (pid 71630); log: <home>/logs/server.log
› member lead (recipe lead)
› container_runtime: ready
› model: qwen3-8b-q4_k_m cached
› model_server: qwen3-8b-q4_k_m serving
› image: asha-image-hello-world current
› lead-1: Hi
› member greeter (recipe greeter)
› container_runtime: ready
› model: qwen3-8b-q4_k_m cached
› model_server: qwen3-8b-q4_k_m serving
› image: asha-image-hello-world current
› greeter-1: Hi
lead-1
greeter-1
```

The handles are stdout; without `--verbose` only they are printed.

**Resuming** (`docs/plans/agent-persistence.md` R8, R9): a launch of a persisted identity restores its saved state first, and with `--verbose` prints `› <handle> resumed from state saved <savedAt>`. If the previous run ended with users' messages to it not yet saved (a crash, or a stop whose ack wait ran out), or with a conversation still waiting on another agent (a call open when the daemon stopped; its message command then printed `No agent could answer this: …`, D62), the launch re-sends each user's `input` once, to that agent alone, in a new conversation marked `redelivered` — framed for the agent with the line `This message was sent before the harness restarted; some of its work may already be done.` (`RETRY_LINE`). To a daemon of its own build the CLI asks to follow them (`followResent: true`): after `launched` (or `team_launched`) it stays attached, prints `› resuming your message from <savedAt>` on stderr for each — always, with or without `--verbose` — and each re-sent reply on stdout after the handle, the models' output only with `--verbose`, and exits `0` at the stream's end once every re-sent conversation has settled; `1` on an `error` event, a cut stream or 60 s of silence. A daemon of another build is not asked, and the launch returns at `launched` as before; the re-sent replies still reach `--watch`. A re-send is delivered at least once: what the interrupted turn did outside the agent's own saved state may be done twice — messages it posted to other agents, blackboard notes, files in `/channel`, model calls, and cloud tool calls such as web searches on the shared Tavily key, which count toward its monthly limit (agent-persistence R9 (g); the agent is told it is a retry). *Corrected 2026-09-29 by the completion review: this listed only a posted message and a file outside `/workspace`.* A team launch (`--launch team=`) follows its members' re-sends the same way: they are released once every member is online, after `team_launched`. The real-model runs of this are [P20](../patterns/p20-resume.md)'s: a conversation waiting on a call at a stop (p20-a) and a long-running tasker killed mid-task (p20-b), green in three recorded runs at `56b92e0`, `0c79534` and `87cdd35` and one under its bound at `b0a4ea3` (2026-10-03; p20-b also at `2d94dc1`, `802b78d` and `5e8f1e3`, 2026-09-29, in its one-member team before).

### `--watch` <span class="badge built">built</span> {#watch}

```
./asha --watch [channel=<channel>] [--verbose]
```

`watch` opens `GET /v1/channel?name=<channel>` (default `main`) and prints every `WatchEvent` until Ctrl-C, after `› watching channel "duo" (agents: hewo-1, hewo-2); Ctrl-C to stop` (or `no agents yet`) with `--verbose`. Lines come from `formatWatchEvent`; `→ all agents` means everyone. With `--verbose`, every conversation's model output is printed on stderr as it is generated, as for a message ([deltas](#deltas)); stdout is the same with or without it.

```
01:27:10Z [413e38ac] internal hewo-1 → hewo-2: Say Hello World   # UTC time, conversation id (8 chars), kind, from → to, text
01:27:11Z [413e38ac] status hewo-2: ok                          # a status in a conversation
HH:MM:SSZ [--------] status hewo-1: Hi                          # a status about the agent itself (format, not a capture)
HH:MM:SSZ [--------] status worker-1: system failure — offline   # the harness's: it went offline unasked
HH:MM:SSZ [--------] status lead-1: launching a new helper agent # the harness's: a launch from its grant began
+ <handle> joined the channel
- <handle> left the channel: <detail>
```

Some statuses are the harness's, posted as the agent's (*since 2026-10-16, `docs/plans/demo-scene-refresh.md` R6, R14, R16*): `system failure — offline` when an online agent goes with no stop asked of it — from its stream's close or its exit, whichever comes first, before it is restarted or leaves, and with no exit code, which the daemon's log keeps (`agent.exited_unexpectedly`); a launcher's `launching a new <recipe> agent`, then `could not launch a <recipe> agent: <reason>` if the launch fails while the launcher is on the channel and not down for its restart — never for a stop, the daemon's or the channel's; and an agent's restart, told the same way: `restarting (<n> of <max> within <s> s)`, `restart <n> failed: <why>` (<why> one of: its container exited before coming online, it did not come online in time, its container failed before coming online, or it could not be started) and `restart limit reached (<n> within <s> s): removed` — or `restart limit reached (the message it held sent again <k> times): removed` when the re-sends are the limit — n counting the restarts begun within the window, and `sent again the message it held` once it is back. `/watch on` prints them the same way. A message a launch re-sent from before a restart ends with ` (resent from before the restart)` (`formatWatchEvent`). A reply with files is followed by one line per file, its metadata only — the watch fetches nothing ([files](#files)):

```
01:27:12Z [413e38ac] output hewo-1 → alice: Here is the summary.
  file summary.txt (812 bytes, sha256 9b1e…)
```

**Exit** `0` on SIGINT (Ctrl-C), SIGTERM or SIGHUP; `1` when the daemon ends the watch with an error (`✗ slow_reader: …`, when the watcher fell more than 1 MiB behind), when it closes the stream (`✗ the daemon closed the channel stream`, followed by the socket's reason in parentheses when the daemon stopped mid-stream), 60 s of silence, a non-2xx answer (`✗ the daemon refused the watch: HTTP …`, e.g. HTTP 400 for a bad channel name), or no daemon; `2` on any argument but `channel=`.

### `--interactive` <span class="badge built">built</span> {#interactive}

```
./asha --interactive [user=<id>] [recipe=<recipe>] [channel=<channel>] [to=<handle>] [--verbose]
```

A session on one channel (default `main`): each line you type, ending with Return, is posted as one message, exactly as `message=<line>` would be, and its replies are printed; then the next line is read. `interactive` in [src/cli/interactive.ts](../../src/cli/interactive.ts) runs it, reusing `converse` for every message.

- **Lines.** One message per line, so a pasted block of three lines is three messages. The line is text as typed: `key=value` inside it is text. A blank or all-whitespace line is skipped. Piped input works the same (`printf 'a\nb\n' | ./asha --interactive user=bob`); a last line without a newline is a message too.
- **A path in a line attaches its file** ([files](#files); `lineAttachments` in [src/cli/attach.ts](../../src/cli/attach.ts)). The line is split into words at spaces and tabs; a backslash makes the next character literal (`my\ file.txt`), and a word that starts with a quote and ends with the same quote is one word, the quotes removed (`'my file.txt'`) — as a path dragged in from Finder is typed. **Only a word that contains `/` or starts with `~/` is tried**, so a file in the current folder is `./notes.txt`: a bare `notes.txt` stays text and attaches nothing. Punctuation after or before a path is tried off it too (`./notes.txt?` attaches `./notes.txt`). `~/` is your home folder. A word that names nothing, or a folder, stays text silently. A word that names a file that cannot be attached — the deny list, a hard link, over the bound, an eleventh file — stays text, prints `⚠ not attached <path>: <rule>` always, and the message is sent without it. At most 10 files a line. The line is posted as typed, path and all. `file=` is refused for a session (`✗ file= is for a single message: in --interactive, a path in a line attaches its file`, exit `2`).
- **Returned files** are saved as for a single message, each `file:` line printed after its reply; with `/watch on`, after the view has printed the reply.
- **Every message** carries the session's `user=`, `to=` (else everyone) and `recipe=`, so the first message brings the recipe's agent online and a later one brings it back after a daemon restart; nothing is launched before the first line. Each message finds or starts the daemon afresh from `daemon.json`, as a single command does.
- **One at a time.** The next line is read once no agent is still working on the message before; lines typed meanwhile wait in the input and are handled in order. Each message keeps the single command's 60 s stream-silence bound; the prompt itself waits for as long as you like.
- **Failures don't end it.** A message that fails prints its `✗` line and the session goes on; the exit code at the end is then `1`.
- **The prompt** `asha> ` is printed on stderr before each line is read, only when input is a terminal. The terminal keeps its own line editing (Backspace, Ctrl-U); there is no history.
- **Who speaks.** Every message comes from one user: the typed `user=`, or else your login name, converted and checked once before the first prompt exactly as for a [single message](#message) — a changed name is announced once, a name that still breaks the rule ends the session before the prompt, exit `1`. *(Until 2026-09-29 a session without `user=` was refused, while the login-name default was not built.)*

**Commands** — a line whose first word is `/` followed only by letters, and is not an existing file or directory (so a line starting `/tmp` or a dragged-in `/Users/me/report.pdf` is a message):

| Command | Does |
|---|---|
| `/quit` | Ends the session once the lines before it are done; nothing after it is read. |
| `/watch on` | Switches stdout to the whole channel, printed as [`--watch`](#watch) prints it, with `» reply from <handle>:` before each reply to you; prints `watching the channel` on stderr. It returns once the daemon watches the channel, and a message is done only once the view has printed its replies — waiting at most 60 s (the stream-silence bound), after which a reply the view has not shown is printed from the conversation after `⚠ the channel view did not show this reply within 60000 ms; printed from the conversation:`. The view keeps printing between messages, while the prompt waits. With `--verbose`, the view prints the models' output ([deltas](#deltas)) and the conversation prints none, so each fragment appears once. |
| `/watch off` | Back to only your replies; prints `replies only`. |
| anything else | `unknown command /<word>; type /quit to leave` on stderr; nothing posted; the session goes on and exits `1`. `/watch` with any argument but `on` or `off` is one. |

If the channel view's stream is cut (the daemon stops, or 60 s of silence), the session prints the `✗` line [`--watch`](#watch) would, turns the view off, counts a failure, and goes on; a reply to the message in flight that the view had not shown is printed from the conversation, so none is lost. It does not reconnect — type `/watch on` again.

If reading your input fails (the terminal went away), the session prints `✗ reading your input failed: <reason>` and exits `1`.

**Leaving.** `/quit`, or the end of input (Ctrl-D at the start of a line, or the end of piped input) once every line read is done: exit `0`, or `1` if any message or command failed. **Ctrl-C** ends the session at once with exit `130`: a message still being worked on is abandoned — the CLI hangs up its stream, the agents keep working, and their reply is lost. The terminal's mode is never changed, so nothing needs restoring. (`--watch`, by contrast, exits `0` on Ctrl-C, because that is how a watch ends.)

With `--verbose`, each message's progress is printed as for a single message, its `posted` line naming your user ID.

### `--status` <span class="badge built">built</span> {#status}

`status` never starts a daemon: daemon and agent lines, exit `0`; `stopping (pid <pid>)`, exit `1`, while a daemon of this home is stopping (it takes no new work; since 2026-10-03, `docs/plans/debt-paydown.md` R16, [finding the daemon](#daemon)); or `not running`, exit `1`.

<p class="pre-label">captured 2026-09-27 (recaptured after the wording changed to plain <code>asha</code>), with a daemon started before the latest rebuild</p>

```
$ ./asha --status
⚠ the running daemon (pid 29364, started 2026-09-27T03:00:36.065Z) runs a different build (73c27b89b36e) than this asha (ccfef73911fe), and so do its agents. Run asha --stop to use this build.
running: pid 29364, port 49992, version 0.1.0, build 73c27b89b36e, started 2026-09-27T03:00:36.065Z
  hewo-1  channel=main recipe=hello-world image=hello-world
```

The `⚠` line (stderr) appears only when the builds differ.

An agent granted a cloud module or a hosted model shows ` cloud=<module>,<module>/<model>` at the end of its line, the vendors it may send data to; and each enabled metered module adds a line `  <module> spend <day>/<cap> today, <month>/<cap> this month (UTC), USD` from the [meter](../architecture/modules.md#cost), the amounts in USD as the meter holds them.

### Modules: `--install-module`, `--uninstall-module`, `--set-secret`, `--enable-module`, `--approve` <span class="badge built">built</span> {#modules}

*Built by `docs/plans/extension-modules.md`, 2026-10-02* ([Modules](../architecture/modules.md); [`src/cli/modules.ts`](../../src/cli/modules.ts)).

- **`--install-module path=<dir> [archive=<file>] [--yes]`** installs a module from a directory — this repository's `modules/<id>` or a separate package, checked identically — refusing while a daemon of the home answers (`✗ a daemon is running for this home; stop it first: asha --stop`, exit 1) and otherwise holding `daemon.lock`. It downloads nothing. It prints the summary (id, version, hosts with every wildcard, secrets, each tool with its classes, bound and description, the cost model and its approval) and asks `yes` at a terminal; off one only `--yes` proceeds. A command plugin needs `archive=`, its release archive for the colima VM's architecture: without it the refusal names the URL to download and the sha256 the file must have; a link, a FIFO, a directory, a file over 1 GiB or one whose sha256 differs is refused, naming the path. Only a licence on the allowlist is installed (`MIT`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`); for a command plugin only the program's own licence is checked.
- **`--uninstall-module id=<id> [--yes]`** removes the module and its secrets, under the same rules.
- **`--set-secret module=<id> name=<NAME>`** stores one of the module's declared secrets, read from standard input only (`pbpaste | asha --set-secret module=tavily name=TAVILY_API_KEY`): an argument is a usage error, and it refuses at a terminal, where the value would show as typed. It writes the store itself, never through the daemon, and prints only the name and the length. A second writer meanwhile is refused naming the holder's pid; run it again.
- **`--enable-module id=<id> conversation=<usd> day=<usd> month=<usd>`** turns on a metered module with all three caps, each at most its manifest's approved cap: through the daemon when one answers (its `409` reasons `not_installed`, `not_metered` and `over_cap` printed, exit 1), else under `daemon.lock`, writing `metering.json` itself.
- **`--approve id=<id> [--yes]`** shows a call an agent asked to make and approves it ([approvals](../architecture/modules.md#approvals)). It prints the request on stderr — agent, channel, conversation, `<module>/<tool>`, the arguments and the sha256 it computes from what it printed, every invisible or direction-changing character as a `\u` escape (`\u202e`; above U+FFFF `\u{e0041}`) and an accented letter as itself — then asks `Approve this call? Type yes to approve: ` at a terminal and approves only on the exact answer `yes`; off a terminal only `--yes` approves. asha then makes the call, and `--approve` prints `✓ approval <id>: asha made the call <module>/<tool>: ok` and the result's JSON, then the agent's reply, exit 0; or `✗ approval <id>: asha's call <module>/<tool> failed: <reason>`, or for a command that exited non-zero `✗ approval <id>: asha's call <module>/<tool> ran and exited <n>` and its result, exit 1.

| `--approve` refuses with | When | Exit |
|---|---|---|
| `✗ approval <id>: unknown`, `expired`, `agent_gone` | no such request; past its 10 minutes; its agent has left | `1` |
| `✗ approval <id>: the request's sha256 does not match what was shown` | the daemon's sha256 differs from the one computed from the printed fields; nothing sent | `1` |
| `✗ approval <id>: not approved` (`: not at a terminal, and --yes was not given`) | any answer but `yes`; the request stays pending | `1` |
| `✗ approval <id>: mismatch` | the daemon's check of the sha256 sent | `1` |
| `✗ approval <id>: the daemon is stopping` | 503 | `1` |
| `✗ unknown_handle: <agent> could not be given the result of approval <id> (it has left); the call's outcome: …` | the agent left while the call ran: the call was made, the result reached no agent | `1` |
| `✗ pending_full: <agent> could not be given the result of approval <id> (its record of unsaved deliveries is full); the call's outcome: …` | a persisted agent holds 32 unsaved deliveries or 4 MiB of them: the call was made, the result reached no agent (logged `module.approval_undelivered`) | `1` |
| `✗ approval <id>: the request's arguments are not RFC 8785 JSON` | the arguments the daemon sent are not their own canonical string (a duplicate key, a space); nothing sent | `1` |
| `✗ approval <id>: no outcome within <n> ms; the call may still complete: see the audit` | no outcome within the tool's `timeoutMs` + 10,000 ms (heartbeats do not count) | `1` |

### `--stop` <span class="badge built">built</span> {#stop}

`stop` sends SIGTERM (no build warning: stopping is its fix) and polls every 200 ms. The daemon marks `daemon.json` `stopping: true` and answers 503 (`reason: 'stopping'`) to control requests, stops its agents — each finishing the work it has started, up to 65 s ([stopping](../architecture/channel.md#stop)) — then closes its listener, stops the model servers, releases its lock, and removes `daemon.json` (`stopDaemon` in [src/daemon/compose.ts](../../src/daemon/compose.ts); [a stopping daemon](../architecture/index.md#stopping)). A daemon already stopping is sent no signal: `stop` waits for its pid the same way (debt-paydown R16).

| Outcome | Output | Exit |
|---|---|---|
| Stopped | `stopped (pid <pid>)` | `0` |
| Nothing to stop | `not running` | `0` |
| Still alive after 90 s | `✗ daemon pid <pid> is still running 90000 ms after SIGTERM` | `1` |
| Already stopping, still alive after 90 s | `✗ daemon pid <pid> is still running 90000 ms after this --stop began waiting for its stop` | `1` |

#### One channel: `--stop channel=<channel>` {#stop-channel}

`--stop channel=<channel>` stops that channel's agents and leaves the daemon running: it sends `POST /v1/channel/stop` ([APIs](../architecture/index.md#apis)), and the daemon stops each agent on the channel as its own stop does ([one channel's stop](../architecture/channel.md#channel-stop)), removes the channel's file space, then stops each model server no agent still needs ([Models](../architecture/models.md#serving)). It never starts a daemon. With `--verbose` it first prints `› stopping <handle>, … on channel <channel>` on stderr (`ChannelStopPrinter` in [`src/shared/lines.ts`](../../src/shared/lines.ts); the portal's [Stop demo](../portal/index.md#demo-stop) prints the same lines).

| Outcome | Output | Exit |
|---|---|---|
| Stopped | `stopped <handle>` per agent, then `stopped the model server for <model>` per server stopped | `0` |
| No agent on the channel | `✗ no agent is on channel "<channel>"` | `1` |
| No daemon running | `✗ no daemon is running` | `1` |
| The stop failed | the agents it stopped, then `✗ <detail>` (`✗ the stop of channel p05-1 failed: worker-a-1 still running after the stop`) | `1` |
| The daemon closed the stream first | `✗ the daemon closed the stop of channel <channel> before it was done` | `1` |
| A malformed argument (`channel=`, `name=x`, a bad name) | `--stop takes nothing, or channel=<name> (…)`, then the usage | `2` |

### `--list-state` and `--reset-state` <span class="badge built">built</span> {#state}

What persisted agents and teams have saved (`docs/plans/agent-persistence.md` R5, R16; [where things live](../architecture/index.md#state)). Both go through the daemon when one answers (`GET /v1/state`, `POST /v1/state/reset`, with the control credential); with none, they read and change the files themselves, holding `daemon.lock` for the command so no daemon starts meanwhile — except an erase, which needs a daemon and starts one ([`src/cli/state.ts`](../../src/cli/state.ts)).

```
./asha --list-state
./asha --reset-state all | channel=<channel> [name=<name> [team=<team>]] [--yes]
./asha --reset-state channel=<channel> [name=<name> [team=<team>]] user=<id> [--yes]
```

**`--list-state`** prints one line per saved asset, `<agent|channel> <identity> <memory|workspace|board|files> <bytes> <savedAt>` (a channel's `files` counting its file table's bytes too), with ` full` when a bound was reached and ` tainted` when a channel was saved while an agent that keeps memory was online on it; then `agent <identity> pending <bytes> <savedAt>` for each agent with unsaved messages (the oldest one's time); then `total <bytes> in <n> assets`. An identity whose pointer or record does not read, or a stray file where the store keeps only directories, is listed as asset `unreadable` with the bytes under it and `savedAt` `unknown` — the daemon refuses to start over it (`StateStoreCorrupt`, naming the path), and `--reset-state` of the selector that covers it removes it whole (`removed … unreadable (<n> bytes)`). Nothing saved: `nothing saved`. An identity is `<channel>/<team or ->/<name>`. Exit `0`.

**`--reset-state`** removes exactly what it names — one agent (`channel= name=`, with `team=` for a team member), a channel's agents, its board and its files (`channel=`), or everything (`all`) — printing `removed <agent|channel> <identity> <asset> (<bytes> bytes)` for each, an agent's `pending` record among them; exit `0`. For `all` and `channel=` it first prints the matching `--list-state` lines and total, then on a terminal asks you to type `reset`, and off one needs `--yes`; anything else is `✗ reset cancelled`, exit `1`. An identity that is online (or being erased) is refused and nothing is removed; while a reset runs, a launch of an identity it removes is refused `identity_in_use`: `✗ <identity> is online; stop it first (asha --stop)`, exit `1`. A selector matching nothing: `✗ nothing saved matches <selector>`, exit `1`. A malformed one (a bad name, `team=` without `name=`, `all` with anything): `✗ …`, exit `2`, before any path is formed.

**`--reset-state … user=<id>`** erases one user's saved memory from the agents named ([persisted memory](../architecture/memory.md#persisted)); `/workspace`, the board, the channel's files (`/channel`, the files that user attached included) and a persisted channel's file table are shared by every user and kept. It prints, per agent, `erased user <id> from agent <identity> memory (<n> files, <n> bytes)` or `no memory of user <id> in agent <identity>`, `erased user <id> from agent <identity> pending (<n> messages)` when it also removed that user's unsaved messages, `kept <kind> <identity> <asset>: shared by every user of the channel, not erased`, and `✗ could not erase user <id> from agent <identity>: <reason>` for one that failed — with the `pending` line when that user's unsaved messages were removed before the failure — going on to the next; exit `0` when every agent was erased or held nothing of the user, else `1`. The reasons: `erase_unsupported`, `exit_nonzero`, `timeout` (60 s), `bad_output`, `save_failed`, `erase_not_subset` — each leaves that agent's saved state as it was. `channel=` without `name=` confirms as a reset does. An erase never takes your login name: `user=` is required, and `all … user=` is refused, exit `2`. The answer is a stream with heartbeats, so a long erase is not cut by the 60 s silence bound.

> [!WARNING] What saved state costs, and what a reset does not reach
> - **Anyone who can run `asha` can read, reset or erase any user's saved state by naming them:** saved memory, `/workspace` and a persisted board are served to whoever claims the user name or uses the channel (D2).
> - **A full `/memory`** (64 MiB, 4,096 files or 8,192 entries for the whole agent) stops being saved for every user of that agent, each later checkpoint failing `over_bound` (`state.save_failed` in the log each time; the `⚠ … not being saved` line once per agent per daemon run), until a reset or an erase makes room.
> - **Backups** (Time Machine) made before a reset or erase still hold what it removed; so does the info-level `channel.user_online` log line.
> - **An erase removes one user's own memory, not what others' memories say about them:** another user's saved memory that mentions them is kept (agent-persistence R16). *Corrected 2026-09-29 by the completion review: this limit was missing.*

### `--portal` <span class="badge built">built</span> {#portal}

```
./asha --portal [user=<id>]
```

Opens the [portal](../portal/index.md), asha's web page, in your default browser. It finds or starts the daemon as a message does and takes your user ID from `user=` or, without it, from your login name, as a message does (its `›` line when converted, its `✗` line and exit `1` when it cannot be one). It writes `ASHA_HOME/portal.html` (`0600`, renamed into place, replacing an earlier one), whose only content sends the browser to `http://127.0.0.1:<port>/#c=<credential>&u=<user ID>` — the fragment is read by the page and never sent in a request — and runs `open` on it (found by `PATH`), bounded by 10 s.

| Outcome | Output | Exit |
|---|---|---|
| Opened | `portal: http://127.0.0.1:<port>/` on stdout | `0` |
| `open` could not start, exited non-zero, or ran 10 s (killed) | `✗ could not open a browser (<reason>); open <ASHA_HOME>/portal.html in one` | `1` |
| Any argument but `user=` | `--portal takes only user=<id>` and the usage | `2` |
| `user=` naming no valid user ID | `✗ <why>`, as `--reset-state` says it (e.g. `✗ a user ID is 1 to 32 characters: …`); nothing written or opened | `2` |

The credential is in no output, no process's arguments and no log record. asha never removes `portal.html`; it holds a credential that dies at the daemon's next start.

### `--server` <span class="badge built">built</span> {#server}

`server` runs the daemon in the foreground, as the background start does. `startDaemon` takes `daemon.lock`, listens on `127.0.0.1` (OS-picked port), writes `daemon.json` (`{pid, port, credential}`, mode `0600`, [below](#daemon)), and on SIGINT, SIGTERM or SIGHUP (a closed terminal) shuts down as [`--stop`](#stop) describes, exit `0`. Every signal goes to the daemon's one stop trigger, which the portal's `POST /v1/stop` calls too: the first request starts the stop, logged `daemon.stop_requested` with its `source` (`signal` and the signal, `portal`, or the daemon's own [lifetime](../architecture/index.md#lifetime): `idle` and the `idleMs` it measured, `parent_exited` and the `pid`); a later one (a second Ctrl-C, a shutdown during `asha --stop`, a signal after the portal's stop) is logged with `ignored: true` and changes nothing ([`src/cli/signals.ts`](../../src/cli/signals.ts), `RunningDaemon` in [compose.ts](../../src/daemon/compose.ts)). `--server` exits `0` once the stop is done, whoever began it. Run by you, it stays until you stop it; a daemon a command started for you leaves after 30 idle minutes (`ASHA_IDLE_EXIT_MS`, [below](#env)). *(Changed 2026-10-02 by `docs/plans/portal.md` R14: the records were `daemon.signal`.)*

Banner: `asha <version> serving on 127.0.0.1:<port> (pid <pid>); home <home>`. Log records go to `logs/daemon.jsonl` and stderr (`JsonLinesLogger` in [src/daemon/log.ts](../../src/daemon/log.ts)). Failures: `jq -c 'select(.level=="error")' ~/.simplyautonomous/harness/logs/daemon.jsonl`.

A live lock holder makes `acquirePidLock` throw `LockHeld`, uncaught, so Node exits `1`; a dead holder's lock is retaken.

TODO: no captured run of --server, or of a second --server refused by the lock, yet

### `--help` <span class="badge built">built</span> {#help}

Prints the [usage](#synopsis) to stdout and exits `0`; only as the sole argument.

### `--verbose` <span class="badge built">built</span> {#verbose}

Every command accepts it, anywhere on the line, and it adds the `›` progress lines on stderr: the steps of bringing an agent online, the posted message with your user ID, each file attached (`attached <path> as /channel/upload-…/<name> (<n> bytes)`, [files](#files)), agents' `status` and `internal` messages, agents leaving, the `--watch` banner, `› started the asha daemon …` when a command starts the daemon, and the models' output as it is generated ([deltas](#deltas)). It changes nothing on stdout and no exit code.

*Changed 2026-09-28 (the owner's answer of 2026-09-27, `docs/plans/cli-interactive.md`):* until then progress was printed by default and `--quiet` hid it. asha is now quiet by default, and `--quiet` is refused wherever it appears, exit `2`, before any daemon is found or started: `--quiet is gone: asha is quiet by default; add --verbose for progress`, a blank line, and the usage — so a script that passes it learns of the change instead of quietly getting something else.

## stdout and stderr {#streams}

**stdout carries the result. stderr carries what you must see — `✗` errors, `⚠` warnings (a stopping daemon's `⚠ the asha daemon (pid <pid>) is stopping; waiting for it to stop` among them, [finding the daemon](#daemon)), the notices about a stale `daemon.json`, usage errors, `› your login name "<name>" is sent as user ID "<id>"` when the login name had to be converted ([`user=`](#message)), a resuming launch's `› resuming your message from <savedAt>` ([`--launch`](#launch)), and the harness's own `⚠` lines ([saved state](#state)) — and, only with [`--verbose`](#verbose), the `›` progress.** *(Corrected 2026-09-29: this said the `›` lines were printed only with `--verbose`, false once the login-name ID line was built.)*

| Command | stdout | stderr |
|---|---|---|
| message | the text of each reply (including the harness's no-answer reply); a `file: <path> (<n> bytes, sha256 <hex>)` line per file an agent returned, after its reply | `⚠` build warning, the cloud `⚠` line, `✗` errors (a refused `file=` included), usage errors, the login-name ID line (without `user=`, a converted name only); `›` progress and the `attached` lines with `--verbose`; `? <handle> is waiting for your answer: asha … conversation=<id> message="…"` after an ask ([`conversation=`](#message)) |
| `--interactive` | each reply, or with `/watch on` the channel view; a `file:` line per returned file | the prompt (a terminal only), `⚠ not attached …` and the cloud `⚠` line, `watching the channel` / `replies only`, unknown commands, `⚠` (once per daemon build in a session), `✗`, the login-name ID line once before the first prompt; `›` progress with `--verbose` |
| `--launch` | the new handle; a resuming launch's re-sent replies | `⚠` (the cloud line when a cloud-granted agent joins a channel whose space holds files), `✗`, `› resuming your message from <savedAt>` always; `›` progress with `--verbose` |
| `--list-state`, `--reset-state` | the listing; `removed …`, `erased …`, `no memory of …`, `kept …` | `✗`, the confirmation prompt (a terminal only) |
| `--watch` | one line per channel event; `  file <name> (<n> bytes, sha256 <hex>)` after a reply with files | `⚠`, `✗`; the `› watching …` line and the models' output with `--verbose` |
| `--status` | `running: …` and agent lines, `stopping (pid …)`, or `not running` | `⚠` build warning |
| `--stop` | `stopped (pid …)` or `not running` | `✗` if it will not stop |
| `--portal` | `portal: http://127.0.0.1:<port>/` | `✗` if no browser could be opened; the login-name ID line (without `user=`, a converted name only); `›` progress with `--verbose` |
| `--server` | the `serving on …` banner | every log record as a JSON line |
| `--help` | the usage | — |

`reply=$(./asha message="…")` captures only the answer ([guide](guide.md#quiet)).

**Control characters on a terminal.** When stdout or stderr is a terminal, every C0 or C1 control character and DEL (U+0000–U+001F, U+007F–U+009F) except line feed and tab in what the CLI prints there is printed as `�` (U+FFFD), so a model's reply or another user's message cannot move the cursor, retitle the window or set the clipboard (OSC 52). Output to a pipe or a file is byte for byte (`scrubControl` in [commands.ts](../../src/cli/commands.ts)).

## Exit codes {#exit-codes}

`EXIT` in [commands.ts](../../src/cli/commands.ts): `{ ok: 0, failed: 1, usage: 2, interrupted: 130 }`. `--verbose` changes none of them.

| Code | Meaning |
|---|---|
| `0` | Success, per command above. |
| `1` | Any failure above, or an uncaught error (a rejected top-level await; checked on Node 22.13.1). |
| `2` | Malformed; nothing sent. |
| `130` | Ctrl-C in an [interactive session](#interactive) (128 + SIGINT, the usual code for an interrupt). |

## Finding and starting the daemon {#daemon}

A message (and each message of a session), `/watch on`, `--launch` and `--watch` start one if needed; `--status` and `--stop` only look.

![The find-or-start decision: `findDaemon` and `startServer` in [src/cli/commands.ts](../../src/cli/commands.ts), `spawnServer` in [main.ts](../../src/cli/main.ts).](daemon-discovery.svg)

**Finding** (`findDaemon`, with `parseDaemonFile`):

1. Read `<home>/daemon.json` (`DaemonFile`: `{pid, port, credential}`, and `stopping: true` while the daemon stops; mode `0600`). No file: not running. A file saying `stopping: true` is a **stopping** daemon when its `pid` is alive and is an asha daemon — `ps -o command= -p <pid>` (2,000 ms bound) ends with `/dist/src/cli/main.js --server` — and not running otherwise (a crash or a reboot that left the file, its pid dead or reused); the health is not asked. A `stopping` that is not exactly `true` makes the file unreadable (below). A file that is not JSON, whose `pid` or `port` is missing or mistyped, or whose `credential` is present but not a non-empty printable string, fails every command, exit `1`, never read as "not running": `✗ <home>/daemon.json cannot be read as a daemon file: <what is wrong>. If no asha daemon is running for this home, remove it.`
2. `GET http://127.0.0.1:<port>/v1/health` with `Authorization: Bearer <credential>`, within 3 s (a `HealthResponse`). The CLI sends the credential this way on every request it makes ([the two APIs](../architecture/index.md#apis)).
3. A `401` from a port whose file names a dead `pid` means the daemon crashed and another server took its port: `(daemon file names pid <pid>, which is not running; port <port> now belongs to another server)`, and the CLI goes on as if no daemon ran (a message starts one). A `401` with the `pid` alive means a daemon answers but the file is not its own. It fails, exit `1`, and starts nothing (a second daemon would only meet the held lock): `✗ the daemon on port <port> refused the credential in <home>/daemon.json (HTTP 401), so that file is not this daemon's. If no asha daemon is running for this home, remove the file.`
4. No answer prints `(daemon file names port <port>, which did not answer: <error>)`, once per command however often a start polls the file (`notedStalePorts`); that or another non-2xx counts as not running — but a `503` with `reason: 'stopping'` from a live asha daemon (checked as in 1) is a **stopping** daemon: one that began to stop before it rewrote its file.
5. A different build prints the [`⚠` warning](#status), with or without `--verbose`, once per build in a command or an interactive session; a daemon too old to say shows `unknown, from before builds were tracked`.

**A stopping daemon** (since 2026-10-03, `docs/plans/debt-paydown.md` R16; D21, now paid): `--status` prints `stopping (pid <pid>)`, exit `1`; `--stop` sends nothing and waits ([`--stop`](#stop)); every other command prints `⚠ the asha daemon (pid <pid>) is stopping; waiting for it to stop` on stderr, with or without `--verbose`, polls its pid every 200 ms up to 90 s (the daemon's slowest clean stop, `SERVER_STOP_MS`), then goes on as if no daemon ran — a command that starts one starts one; past 90 s: `✗ the asha daemon (pid <pid>) was still stopping after 90000 ms; see <home>/logs/daemon.jsonl, and if no asha daemon runs for this home, remove <home>/daemon.json`, exit `1` (`findDaemonAfterStop` in [commands.ts](../../src/cli/commands.ts)). A start's own poll treats a stopping daemon as not yet up. Before this, a stopping daemon read as absent: `--status` said `not running`, and a message started a second daemon, which then met the held lock. An older CLI meeting a newer daemon ignores `stopping` and reads the `503` as absent, as before.

**A daemon from before credentials** wrote `{pid, port}` with no `credential`. Its health is asked without one; if it answers, every command but `--stop` fails, exit `1`: `✗ the running daemon (pid <pid>, port <port>) predates credentials: it serves its API to any local process. Run asha --stop to replace it with this build.` `--stop` stops it as before (`SIGTERM`, then `stopped (pid …)`).

**Starting** (`startServer`, `spawnServer`):

1. Spawn `node dist/src/cli/main.js --server`, detached, stdin ignored, output to `<home>/logs/server.log`.
2. With `--verbose`, print `› started the asha daemon (pid <pid>); log: <home>/logs/server.log` (the owner's answer of 2026-09-27: announced only with `--verbose`).
3. Look every 200 ms, up to 20 s.
4. If it dies, look once more (another CLI may have won); otherwise `✗ the daemon exited during startup; see <server.log>`, exit `1`.
5. After 20 s: `✗ the daemon did not answer within 20000 ms; see <server.log>`, exit `1`.

## A conversation, end to end {#flow}

![Each stream line is a `ConversationEvent` ([protocol.ts](../../src/shared/protocol.ts)). The daemon's `conversation` ([src/daemon/server.ts](../../src/daemon/server.ts)) closes only on `error`; the CLI hangs up. `--launch` (`POST /v1/agents`) and `--watch` (`GET /v1/channel`) work alike.](conversation-flow.svg)

## Environment and files {#env}

Read by `harnessPaths` in [src/shared/paths.ts](../../src/shared/paths.ts); empty is unset — but for the three lifetime variables, which `asha --server` reads (`lifetimeFrom` in [commands.ts](../../src/cli/commands.ts)) and refuses unless each is a positive whole number (and `ASHA_EXIT_WITH_PID` a process of this user running now): `✗ ASHA_IDLE_EXIT_MS="0" is not a positive whole number`, exit `1`, before anything starts. A started daemon inherits the CLI's whole environment, with `ASHA_IDLE_EXIT_MS=1800000` added unless it is set (`autoStartEnv`).

| Variable | Default | What it changes |
|---|---|---|
| `ASHA_HOME` | `~/.simplyautonomous/harness` | State, including `daemon.json`; one daemon per home. Created `0700` when it does not exist. |
| `ASHA_MODELS_DIR` | `<home>/models` | The model cache; shareable. |
| `ASHA_IDLE_EXIT_MS` | unset for `asha --server` you run; `1800000` (30 minutes) for a daemon a command starts | Read by `asha --server`: with nothing to do for this long — no agent, no launch or restart in progress, no request or stream open (an open `--watch` or portal tab counts) — the daemon stops itself and exits `0`. Unset, it never stops for idleness ([its lifetime](../architecture/index.md#lifetime)). |
| `ASHA_MODEL_IDLE_MS` | `900000` (15 minutes) | Read by `asha --server`: a model server no call has used for this long is stopped, and started again by the next call that needs it ([idle unload](../architecture/models.md#idle)). |
| `ASHA_EXIT_WITH_PID` | unset | Read by `asha --server`: the daemon stops within 5 s of that process ending. The test suites set it to their own process. |

`ASHA_URL` and `ASHA_AGENT_TOKEN` (`AgentEnv` in [protocol.ts](../../src/shared/protocol.ts)) are for agent containers only. Files under the home (`daemon.json`, `daemon.lock`, `model-server.key`, `users.json`, `logs/server.log`, `logs/daemon.jsonl`, `logs/agents/`, `staging/`, `models/`) are listed in [Deployments](../deployments/index.md#state).

## Time bounds {#bounds}

Every wait is bounded (PRINCIPLES §11): [main.ts](../../src/cli/main.ts) (`timing`) and [commands.ts](../../src/cli/commands.ts).

| Bound | Value | Where |
|---|---|---|
| Health check on a daemon | 3 s | `HEALTH_TIMEOUT_MS` |
| A started daemon answering | 20 s | `timing.serverStartMs` |
| Exit after `--stop` | 90 s | `timing.serverStopMs` |
| Stream silence | 60 s, reset by every line | `timing.streamIdleMs` |
| Poll interval | 200 ms | `timing.pollMs` |
| Heartbeat on open streams | 10 s | `heartbeatMs`, passed by `server` |
| One agent model call | 60 s | `chatTimeoutMs`, passed by `server` |
| An upload's answer ([files](#files)) | 260 s: the daemon answers within 240 s — at most 60 s waiting for the space, then the measurement, the copy and a rollback, at most 60 s each — and the CLI waits 20 s more | `timing.uploadAnswerMs` (`UPLOAD_ANSWER_MS` in [src/shared/timing.ts](../../src/shared/timing.ts)) |
| A returned file's download | 30 s without a byte | `timing.downloadIdleMs` (`DOWNLOAD_IDLE_MS`) |
| `open`, for `--portal` | 10 s, then killed | `PORTAL_OPEN_MS` |

The bounds the [portal](../portal/index.md#failures)'s page waits with are these, from one module both import: [`src/shared/timing.ts`](../../src/shared/timing.ts) (`HEALTH_TIMEOUT_MS`, `STREAM_IDLE_MS`, `UPLOAD_ANSWER_MS`, `DOWNLOAD_IDLE_MS`, `SERVER_STOP_MS`).

Heartbeats keep a 5 GB first download (78 s in the [guide](guide.md#one-agent)) under the idle bound.
