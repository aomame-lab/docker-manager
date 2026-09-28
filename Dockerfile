FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    BACKUP_DIR=/app/backups

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# docker CLI is needed only for pulling the helper image on the host side;
# volume import/export uses the alpine image through the Engine API.
COPY backend /app/backend
COPY frontend /app/frontend

RUN mkdir -p /app/backups

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8080/api/system')" || exit 1

CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
