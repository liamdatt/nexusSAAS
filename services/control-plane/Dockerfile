FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/control-plane/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/control-plane/app ./app
COPY services/control-plane/alembic ./alembic
COPY services/control-plane/alembic.ini ./alembic.ini
COPY services/control-plane/scripts/start.sh ./scripts/start.sh
EXPOSE 9000
CMD ["./scripts/start.sh"]
