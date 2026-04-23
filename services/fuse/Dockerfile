FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y gcc g++ && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
EXPOSE 4020
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4020"]
