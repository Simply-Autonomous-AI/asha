# TEST-ONLY IMAGE — never shipped (tools/release/pack.mts leaves images/suite-* and dist/images/suite-* out).
# docs/plans/agent-files.md's scripted image for the agent suite's container criteria (A3, A6, A11, A12); see
# src/main.ts. Built as the other images are: the staged compiled agent and SDK under app/, /workspace owned by the
# user it runs as, nothing installed. /channel is the harness's volume, mounted at start.
#
# Base pinned by digest (node:22-alpine, the same as images/hello-world/Dockerfile).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json && mkdir -p /workspace && chown node:node /workspace
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/images/suite-files/src/main.js"]
