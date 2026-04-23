FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04
WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y software-properties-common && \
    add-apt-repository ppa:deadsnakes/ppa && \
    apt-get update && \
    apt-get install -y python3.11 python3.11-venv python3.11-dev python3-pip gcc g++ \
    tesseract-ocr tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa libtesseract-dev \
    ffmpeg && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt lxml_html_clean

COPY src ./src
ENV TRANSFORMERS_CACHE=/app/models
ENV NVIDIA_VISIBLE_DEVICES=all
EXPOSE 4010
CMD ["python3", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4010"]
