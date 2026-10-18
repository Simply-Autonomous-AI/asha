# The egress proxy (docs/plans/extension-modules.md R6, R37): the one way out of a module's network. The harness
# stages its build context, the compiled proxy and shared code under app/, and builds it with --network=none. It runs
# with every capability dropped, read-only, on the home's egress bridge and on each module network.
#
# Base pinned by digest: the agent images' base (images/*/Dockerfile).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/src/egress-proxy/main.js"]
