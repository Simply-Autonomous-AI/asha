# Agent images, endpoints, recipes and docker

The detail behind [AGENTS.md](../AGENTS.md) §3 (images, endpoints, recipes,
colima) and §2 (§11).

- **Agent images are rebuilt from the tree under test.** Each image carries a
  `asha.source` label: a digest of every file that went into it, and is tagged
  by it, `asha-image-<name>:<digest hex>`. A changed tree is a new tag and a
  build, never a reuse; an existing tag is never replaced (debt D23: replacing
  one let containerd delete a snapshot mid-build). Anything that runs an agent
  image names the exact tag the agent ran (`agent.starting` `tag`, or
  `docker inspect` of its container), never a bare `asha-image-<name>`.
- **Agents never reach a model server directly.** Every model call goes through
  the harness (`/agent/v1/model/chat`), authenticated by the run's token. This
  is the seam where routing, limits, logging and — later — the channel live.
  It is enforced, not only a convention: every `llama-server` requires a key
  only the daemon holds, and an agent container can reach no host port but
  the daemon's (docs/architecture/index.html#host-inference).
- **Nothing guesses an endpoint or an environment.** A missing `ASHA_URL`,
  `ASHA_AGENT_TOKEN` or docker socket fails loudly (§9). The
  one deliberate automatic behaviour — the CLI starting a daemon when none
  answers — is the owner's product decision, announced on stderr only with
  `--verbose` (the owner's answer of 2026-09-27, record `auto-start-announcement`;
  corrected 2026-09-28: this said "unless `--quiet` is given", and before
  2026-09-27 "every time"; `--quiet` is gone, since asha is quiet by default).
- **A recipe is the whole agent.** It names exactly one image and one model,
  and its bounds. The command line never names an image.
- **Every `docker` command an agent runs by hand** — a probe, a cleanup, an
  inspection — names colima explicitly (`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker …`
  or `docker --context colima …`), and never changes the CLI's current context:
  on the owner's Mac that context is Docker Desktop, so a bare `docker …`
  starts it *(2026-10-01: an agent's leftover probe work started Docker
  Desktop's helper; the owner asked why)*. The colima VM may be shared with
  other projects on this Mac: touch only what you created, labelled, and never
  stop colima.
- **Errors (§11).** The daemon's logging facade is `src/daemon/log.ts`; every
  failure goes through it. The 3am query is in docs/architecture/index.html#logs.
