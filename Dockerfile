FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt

RUN pip install --no-cache-dir \
    -r /app/backend/requirements.txt

COPY . /app

RUN mkdir -p /app/data
EXPOSE 10000
CMD ["sh","-c","python -m uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-10000}"]
