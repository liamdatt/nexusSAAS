FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g tsx@4

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

ARG FLOPRO_NEXUS_VERSION=""
RUN if [ -n "$FLOPRO_NEXUS_VERSION" ]; then \
      uv tool install "flopro-nexus==${FLOPRO_NEXUS_VERSION}"; \
    else \
      uv tool install flopro-nexus; \
    fi

WORKDIR /srv/nexus
COPY runtime/images/runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8765
ENTRYPOINT ["/entrypoint.sh"]
