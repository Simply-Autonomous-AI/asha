# TEST-ONLY IMAGE — never shipped (tools/release/pack.mts leaves images/suite-* and dist/images/suite-* out).
# agent-persistence A17's image whose erase-user exits 1; see src/main.ts. Built as the memory image is: the staged
# compiled agent and SDK under app/, /memory and /workspace owned by the user it runs as, nothing installed.
#
# Base pinned by digest (node:22-alpine, the same as images/memory/Dockerfile).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json && mkdir -p /memory && chown node:node /memory && mkdir -p /workspace && chown node:node /workspace
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/images/suite-erase-fails/src/main.js"]
