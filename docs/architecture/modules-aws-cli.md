---
title: The aws_cli plugin
description: The reference command plugin — the AWS CLI v2 for a CodePipeline example — where its release archive comes from and how to verify it, how to install it, its commands, licences, cost status and its proxy evidence.
---

# The `aws_cli` plugin

`aws_cli` wraps the AWS CLI v2 as a [command plugin](modules.md#plugins), for the owner's example of an agent operating an AWS CodePipeline: read a pipeline's state, retry a failed stage (consequential: held for approval), and upload a file from the channel or a named root to an S3 bucket whose name begins `asha-demo-`. It is never built by the gate.

<div class="facts"><span>verified 2026-10-03</span><span><span class="badge built">built</span> 2026-10-02 (manifest and Dockerfile); never installed or run</span><span>code: <a href="../../modules/aws_cli/module.json"><code>modules/aws_cli/module.json</code></a>, <a href="../../modules/aws_cli/Dockerfile"><code>Dockerfile</code></a></span></div>

> [!SUMMARY]
> - The AWS CLI `2.37.8`, pinned per architecture by the sha256 of its release archive; the archive is not in this repository: download it yourself.
> - Three commands: `codepipeline_get_state`, `codepipeline_retry_stage` (consequential), `s3_upload`.
> - No recipe this repository ships may grant it until this page records the proxy's evidence below, and its cost has no owner's approval yet.

## The release archive {#archive}

The installer downloads nothing: download the archive for your colima VM's architecture (`colima ssh -- uname -m`) and name it at install.

| Architecture | URL | sha256 |
|---|---|---|
| `aarch64` | `https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.37.8.zip` | `00c4bac1cac8624b728d991f821428d5de1e0cb56e3803045b85bff63bedee8b` |
| `x86_64` | `https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.37.8.zip` | `6a2f98fee0901ff623ff9abb5c80f4d67c40e5c0ac5e2ad7afa2ba756a7d5088` |

Each sha256 was computed on 2026-10-01 from the archive downloaded over HTTPS from `awscli.amazonaws.com`; the version was the newest in the AWS CLI v2 changelog that day. **Verify the signature** before installing, as AWS's [install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (read 2026-10-01) describes: import the AWS CLI Team's public key from that page (fingerprint `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`, expires 2027-07-01), download the `.sig` beside the archive (same URL with `.sig`), and run `gpg --verify awscli-exe-linux-<arch>-2.37.8.zip.sig awscli-exe-linux-<arch>-2.37.8.zip`.

**Both pinned archives were verified this way on 2026-10-03** (`docs/plans/debt-paydown.md` R6, which paid D50): the key block read again from the install guide was byte-identical to the one kept as `evals/probes/debt-paydown-2026-10-03/p5-aws-cli-public-key.asc.txt`, its fingerprint the manifest's; each archive's sha256 was its pin; `gpg --verify`, run with GnuPG 2.4.9 in a throwaway `node:22-alpine` container (nothing installed on the Mac), printed `VALIDSIG FB5DB77FD5C118B80511ADA8A6310ACC4672475C` for both, and `BADSIG` for a copy with one byte appended; the key is valid until 2027-07-01 (`evals/probes/debt-paydown-2026-10-03/r6-aws-cli-verify.out.txt`, script `evals/probes/debt-paydown-2026-10-03/r6-aws-cli-verify.mjs`). The manifest's `executable.signature` records that run, and [`tests/unit/plugin-signatures.test.ts`](../../tests/unit/plugin-signatures.test.ts) fails on any command plugin whose `signature.method` does not record `VALIDSIG` and its own fingerprint, or whose `verifiedBy` names no committed run that shows, for every archive pinned now, its sha256 as the pin, `VALIDSIG` by that fingerprint and `EXIT=0` — so an archive re-pinned without a new run fails it. *Corrected 2026-10-03: this said the check had not been done (D50).* The key expires 2027-07-01: a release pinned after that date is verified against the key as the install guide then gives it.

```
asha --install-module path=modules/aws_cli archive=<the downloaded .zip>
```

The installer checks the archive's sha256 against the manifest for the VM's architecture, refusing any other file, and builds the image with `--network=none` from the plugin base, unzipping the archive and running its installer. **A recorded deviation from R28** ("the build runs only the archive's own installer"): the slim plugin base has no `unzip`, so the harness's own `unzip.mjs` in the plugin base (Node's `zlib`, no download) unpacks the archive before the release's installer runs.

## Commands {#commands}

| Command | Runs | Classes |
|---|---|---|
| `codepipeline_get_state` `{pipeline}` | `aws codepipeline get-pipeline-state --region us-east-1 --output json --name <pipeline>` | `egress` |
| `codepipeline_retry_stage` `{pipeline, stage, execution}` | `aws codepipeline retry-stage-execution --region us-east-1 --output json --retry-mode FAILED_ACTIONS --pipeline-name … --stage-name … --pipeline-execution-id …` | `egress`, `consequential` |
| `s3_upload` `{source, destination}` | `aws s3 cp --region us-east-1 --only-show-errors <source> <destination>`, `source` a read path, `destination` `s3://asha-demo-<name>/<key>` | `egress` |

Names match `^[A-Za-z0-9][A-Za-z0-9.@_-]{0,99}$`, so no value can begin with `-` or add an option. Hosts: `codepipeline.us-east-1.amazonaws.com`, `s3.us-east-1.amazonaws.com`, `*.s3.us-east-1.amazonaws.com`. Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, set on each command's container alone; `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are `/dev/null` and `AWS_PAGER` is empty.

## Licences {#licences}

The AWS CLI v2's own licence is `Apache-2.0` ([LICENSE.txt at 2.37.8](https://github.com/aws/aws-cli/blob/2.37.8/LICENSE.txt), read 2026-10-01), the one licence the installer checks. **Its bundled components are not assessed** (the owner's answer, `plugin-bundled-licences`); read on 2026-10-01 from the release's `aws/THIRD_PARTY_LICENSES`, they are: botocore, s3transfer, colorama, prompt-toolkit, dateutil, PyInstaller 3.5, six, urllib3, setuptools, wcwidth, jmespath, ruamel.yaml, OpenSSL, Python 3.9.11 and docutils — among them PyInstaller under GPL with its bootloader exception. *Corrected 2026-10-02 (completion review, finding 29):* this said chardet and the CA bundle are under LGPL-2.1 or later; neither is in the list above, read from the release, so the claim had no source and is withdrawn; no listed component's licence but PyInstaller's has been read. None of them is in this repository: the user supplies the archive.

## Threat model {#threats}

| Concern | What holds it |
|---|---|
| The AWS keys leak | Set on each command's container alone, for that command, never a module container or an agent's; the CLI's own config and credential files are `/dev/null`; stdout and stderr redacted of them; the IAM user, created only with the owner's consent, is to allow only the three commands' actions on the demo pipeline and `asha-demo-*` buckets, with an AWS Budget behind it |
| The plugin reaches elsewhere | Only the three hosts above on port 443, through the egress proxy with the server name checked, from an internal network; the program honouring `HTTPS_PROXY` is not yet shown ([below](#proxy-evidence)), and until it is, a request that ignores the proxy fails rather than leaving |
| An argument that becomes an option or a file read | Every value typed and matched against its pattern; none may begin with `-`, `file://`, `fileb://` or `@`; the command is an array with no shell |
| Local files sent away | `s3_upload` reads only a path inside the channel space or a named root, checked and copied (no mount), deny-listed credential files and files holding a stored secret refused; in a recipe that also grants an `untrusted-input` tool, it is held for approval (R15) |
| A consequential action | `codepipeline_retry_stage` is held for the user's approval and audited, made once by asha with the approved arguments |
| Prompt injection in what AWS returns | A pipeline's state can hold text others wrote (commit messages, action summaries); it reaches the model only as the command's result, cut to 8,192 bytes — which bounds it but cannot stop a model following it; the plugin is classed `egress`, not `untrusted-input`, so R15's hold does not trigger on its own output (a stated limit) |
| A hostile release | The archive is pinned by sha256 per architecture, and its signature by the AWS CLI team's key was verified for both pins ([above](#archive)); it runs only in its own container, as user 1000 with every capability dropped. Not covered: a release signed with the team's own key, or a compromise of that key |

## Cost {#cost}

Cost model `external-unmetered`, with no `cost.approved`: a launch granting it is refused until the owner approves an estimate recorded here, its manifest carries the approval, and an AWS Budget scoped to its IAM user is recorded (R18c). The credential, allowed only the commands' actions, is created only with the owner's consent at that time.

## R6 (b) proxy evidence {#proxy-evidence}

TODO: that the AWS CLI sends its requests through `HTTPS_PROXY` to the egress proxy is not yet shown; the first opt-in live run records here the request the proxy saw. Until it does, no recipe this repository ships may grant this plugin (a unit test reads this section).
