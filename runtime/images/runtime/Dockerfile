FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates nodejs npm git openssh-client libreoffice libreoffice-calc fonts-liberation fonts-dejavu-core \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git@github.com:" \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g tsx@4

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

ARG NEXUS_GIT_REPO="liamdatt/NEXUS"
ARG NEXUS_SHA=""
RUN if [ -z "$NEXUS_SHA" ]; then \
      echo "NEXUS_SHA build arg is required" >&2; \
      exit 1; \
    fi \
    && uv tool install "flopro-nexus @ git+https://github.com/${NEXUS_GIT_REPO}.git@${NEXUS_SHA}" \
    && uv tool install "nano-pdf>=0.2.1"

WORKDIR /srv/nexus
COPY runtime/images/runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8765
ENTRYPOINT ["/entrypoint.sh"]
