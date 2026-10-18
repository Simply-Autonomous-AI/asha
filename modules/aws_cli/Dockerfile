# The AWS CLI v2 as a command plugin (docs/plans/extension-modules.md R27, R28; docs/architecture/modules-aws-cli.md).
# Built only by the opt-in live check, never by the gate, from the release archive the user downloads and names with
# archive= (checked against module.json's sha256 for the VM's architecture); the build reaches no network.
ARG ASHA_PLUGIN_BASE
FROM ${ASHA_PLUGIN_BASE}
ARG ASHA_ARCHIVE
COPY ${ASHA_ARCHIVE} /tmp/awscli.zip
# The release's own installer, after the plugin base's unzip (the slim base has no unzip).
RUN node /usr/local/lib/asha/unzip.mjs /tmp/awscli.zip /tmp/awscli \
 && /tmp/awscli/aws/install --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin \
 && rm -rf /tmp/awscli /tmp/awscli.zip
USER 1000:1000
