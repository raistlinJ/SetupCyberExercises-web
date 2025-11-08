# syntax=docker/dockerfile:1
FROM python:3.12-slim

# Set envs
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

# Workdir
WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python deps first (better caching)
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy app
COPY app ./app

# Expose port
EXPOSE 8080

# Run with gunicorn (single-line JSON array for broad parser compatibility)
CMD ["gunicorn", "-b", "0.0.0.0:8080", "--worker-class", "gthread", "--threads", "4", "--timeout", "60", "--graceful-timeout", "30", "--keep-alive", "2", "--log-level", "info", "app.wsgi:app"]
