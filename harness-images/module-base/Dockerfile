# The extension modules' base image (docs/plans/extension-modules.md R5, R6 (b), R37). The harness stages its build
# context: the compiled module runtime and shared code under app/ — nothing else. Every ToolModule's and
# ModelProvider's image is built FROM it with the installed module directory copied to /module, by the harness, with
# --network=none: no npm install and no network.
#
# Node's fetch sends every request through the egress proxy, which every module network names asha-egress (R6 (b);
# premise probe P2, evals/probes/extension-modules-2026-10-01/: NODE_USE_ENV_PROXY=1 in this pinned Node 22.23.2).
# Plain http:// requests go to the proxy too, which refuses and logs them.
#
# Base pinned by digest: the agent images' base (images/*/Dockerfile).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://asha-egress:3128 HTTP_PROXY=http://asha-egress:3128
WORKDIR /app
RUN printf '{"type":"module"}\n' > /app/package.json
COPY app/ /app/
USER node
ENTRYPOINT ["node", "/app/src/module-runtime/main.js"]
