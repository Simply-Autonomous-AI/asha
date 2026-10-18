# asha Privacy Policy

Effective 2026-10-18.

This policy explains what happens to data when you use asha, the Autonomous Simple Harness for Agents, and what
SimplyAutonomous.AI, LLC ("the Company", "we", "us") receives. It covers asha and this repository, not any website.

## In short

All the data asha uses stays on your machine, unless a tool call sends it somewhere. asha has no telemetry, analytics,
crash reporting or usage tracking, and it sends nothing to the Company.

## What stays on your machine

asha runs on your own computer: its daemon, its agents (in containers on your machine) and the models (served on
your machine). The messages you send, what agents write, their memory, the files you give them, the logs and traces,
the secrets you enter and the downloaded models are all kept on your machine, under `~/.simplyautonomous/harness`
unless you set another folder. You can remove saved state with `asha --reset-state`, or delete that folder.

## When data leaves your machine

Data leaves your machine only in these cases, and never goes to the Company:

- **Tool calls.** When an agent calls a tool, or uses a module, that connects to an outside service — for example a
  model hosted by a cloud provider or a web search — the data in that call goes to that service, using the account
  and credentials you set up. You choose which tools and modules a recipe allows. What that service does with the
  data is set by its own terms and privacy policy.
- **Agent images, tools and modules you add.** An agent image, tool, module or plugin that you write, change or get
  from anyone other than the Company may send data wherever its maker set it to. The Company is not responsible for
  what such additions do with your data.
- **Model downloads.** When asha needs a model it does not have, it downloads it from Hugging Face (huggingface.co),
  which sees that request as any website would. No account or token is sent.
- **Installing software.** Setting asha up downloads the tools and images it runs on — for example from Homebrew,
  from colima's sources and from Docker Hub — and each of those sees the request.
- **Using GitHub.** Cloning this repository, or opening issues or pull requests on it, is governed by GitHub's own
  privacy statement. Issues, pull requests and comments are public.

## What the Company receives

Only what you choose to send us:

- **Email** to admin@simplyautonomous.ai — for example a security report or a licence request. We use it to answer
  you and to act on what you sent.
- **Contributor licence agreements.** When you agree to the [Contributor Licence Agreement](./CLA.md), we keep a record
  of it: your name, your GitHub account, the email address you give, the agreement's version, the date and a link to
  where you agreed (for an organization, also its legal name and the signer's name and role). We keep it so that we
  can show we have the right to license your contributions, for as long as any of them is part of asha and as long
  afterwards as the law requires. We keep it in the Company's own records, not in any asha repository.

We do not sell personal data. We share it only when the law requires, to protect our rights (for example to show
that we may license a contribution), or with anyone who takes over asha, under this policy.

## Your choices and rights

You can ask to see, correct or delete what we hold about you by writing to admin@simplyautonomous.ai. If you ask us to
delete a contributor agreement record, we may need to remove your contributions from future releases first, because
the record is what lets us keep licensing them.

asha is not directed at children under 13, and we do not knowingly receive their personal data.

## Changes

Each release of asha carries the policy that applies to it, with its effective date. If we change it, the new policy
comes with a later release.

## Contact

SimplyAutonomous.AI, LLC — admin@simplyautonomous.ai.
