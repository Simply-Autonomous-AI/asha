# The Hello World agent. The harness stages this file's build context: the
# compiled agent, SDK and shared protocol under app/, and under
# app/node_modules/ the runtime files of the OpenTelemetry packages the SDK
# sends spans with, copied from the harness's own install — nothing else. No
# npm install and no network: the build only copies.
#
# /workspace is the agent's own directory for its file tools, owned by the user it
# runs as (docs/plans/agent-tools.md R9, R15); it lasts as long as the container.
#
# Base pinned by digest (node:22-alpine, read from the local image 2026-09-26).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json && mkdir -p /workspace && chown node:node /workspace
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/images/hello-world/src/main.js"]
