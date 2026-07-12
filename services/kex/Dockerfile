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

# Bundle the DEFAULT bi-encoder GLiNER model INTO the image ("alles by default
# mitbringen"): the default install must never depend on Hugging Face being
# reachable at runtime. Deliberately NOT under /app/models — that path is
# shadowed by the models volume at runtime; the bundle lives in the image layer.
# The uni fallback (GLINER_FALLBACK_MODEL) still runtime-downloads, but only
# ever runs if the bundled model is missing/corrupt or an operator override fails.
RUN HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60 python3 -c "from huggingface_hub import snapshot_download; snapshot_download('knowledgator/gliner-bi-small-v1.0', local_dir='/app/bundled-models/gliner-bi', allow_patterns=['*.json','spm.model','pytorch_model.bin'])"

COPY src ./src
ENV TRANSFORMERS_CACHE=/app/models
ENV HF_HOME=/app/models
# Robust first-run model download (see prod Dockerfiles).
ENV HF_HUB_DISABLE_XET=1
ENV HF_HUB_ENABLE_HF_TRANSFER=1
ENV HF_HUB_DOWNLOAD_TIMEOUT=30
ENV NVIDIA_VISIBLE_DEVICES=all
EXPOSE 4010
CMD ["python3", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "4010"]
