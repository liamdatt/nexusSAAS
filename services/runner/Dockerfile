FROM docker:27-cli AS docker_cli

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/runner/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/runner/app ./app
COPY runtime/templates /app/runtime/templates

# Embed Docker CLI + Compose plugin so runner can execute `docker compose` via mounted daemon socket.
RUN mkdir -p /usr/local/libexec/docker/cli-plugins
COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
