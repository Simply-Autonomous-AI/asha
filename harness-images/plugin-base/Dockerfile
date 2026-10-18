# The command plugins' glibc base (docs/plans/extension-modules.md R26, R28, R37): every command plugin's Dockerfile
# begins `ARG ASHA_PLUGIN_BASE` and `FROM ${ASHA_PLUGIN_BASE}`, and the harness passes this image's exact tag (its
# source digest names this pinned base). Debian bookworm, because the AWS CLI v2 for Linux needs glibc (AWS's install
# guide, read 2026-09-27); the node image, because it holds a non-root user 1000:1000 (`node`), whom every plugin's
# command runs as (R28's last instruction, `USER 1000:1000`), and Node, with which unzip.mjs unpacks a release zip
# (this slim image has no unzip, and a build reaches no network to install one).
#
# Base pinned by digest: node:22-bookworm-slim, read from the colima VM's image store 2026-10-01.
FROM node:22-bookworm-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c
COPY unzip.mjs /usr/local/lib/asha/unzip.mjs
