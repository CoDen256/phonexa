FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Backend
COPY formanter.py .

# Frontend assets
COPY index.html editor.html debug.html processor.js ./
COPY js/ ./js/
COPY css/ ./css/
COPY lang/ ./lang/

EXPOSE 5050

CMD ["python", "formanter.py"]