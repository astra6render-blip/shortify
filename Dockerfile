# Shortify — self-hostable studio + render server (1080p → 4K)
#   docker build -t shortify .
#   docker run -p 8000:8000 -v "$PWD/renders:/app/renders" shortify
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8000 PYTHONUNBUFFERED=1
# hosts that assign their own port (e.g. Hugging Face Spaces: 7860) override this at runtime
EXPOSE 8000 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)" || exit 1

CMD ["python3", "server.py"]
