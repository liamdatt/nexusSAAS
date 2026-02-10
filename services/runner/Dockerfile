FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/runner/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/runner/app ./app
COPY runtime/templates /app/runtime/templates
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
