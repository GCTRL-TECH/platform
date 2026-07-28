"""
Ground Control (GCTRL) installer - a faithful, cross-platform Python port of the
canonical shell installer served at https://gctrl.tech/install.

The shell script (services/portal/public/install) remains the reference and is
NOT replaced - this is an ADDITIONAL entry point (`pip install gctrl`) that
installs the exact same stack by reusing the exact same server-side artifacts:
the published docker-compose.yml, the license public key, and the pinned image
tags. Nothing about GCTRL itself changes; the pip CLI only orchestrates Docker.

Why re-port instead of shelling out to the bash script: Python removes the
curl/openssl/bash prerequisites (uses urllib / secrets / sockets) so the SAME
install works natively on Windows too, not just macOS/Linux.

Keep this behaviourally in sync with the bash reference when that script changes.
"""

from __future__ import annotations

import json
import os
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# -- Constants (mirror the bash reference) ------------------------------------
GCTRL_VERSION = os.environ.get("GCTRL_VERSION", "latest")
API_URL = "https://api.gctrl.tech"
COMPOSE_URL = "https://gctrl.tech/compose.yml"
PUBKEY_URL = f"{API_URL}/v1/public-key"
INSTALL_DIR = Path(os.environ.get("GCTRL_INSTALL_DIR", str(Path.home() / "gctrl")))
CONFIG_DIR = INSTALL_DIR / "config"
PROFILES_FILE = INSTALL_DIR / ".profiles"  # persisted so `gctrl up` reuses them

WEB_URL = "http://localhost:3001"

NEO4J_USER = "neo4j"

# -- Console output -----------------------------------------------------------
_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _USE_COLOR else s

def info(msg: str) -> None:    print(_c("0;34", "[GCTRL]"), msg)
def success(msg: str) -> None: print(_c("0;32", "[GCTRL]"), msg)
def warn(msg: str) -> None:    print(_c("1;33", "[GCTRL]"), msg)
def die(msg: str) -> None:
    print(_c("0;31", "[GCTRL]"), msg, file=sys.stderr)
    raise SystemExit(1)


# -- Small helpers ------------------------------------------------------------
def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None

def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    """Run a command, inheriting stdio by default. check defaults to False."""
    return subprocess.run(args, **kw)

def run_quiet(args: list[str]) -> int:
    return subprocess.run(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode

def probe_tcp(port: int, host: str = "127.0.0.1", timeout: float = 2.0) -> bool:
    """True if something is listening on host:port (the /dev/tcp probe, portably)."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False

def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "gctrl-pip-installer"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 (trusted host)
        dest.write_bytes(r.read())

def _read_prev_env(key: str) -> str:
    """Value of `key` from an existing INSTALL_DIR/.env, or '' - so secrets and
    a bundled DB's baked-in auth are preserved on re-install (never rotated)."""
    env = INSTALL_DIR / ".env"
    if not env.exists():
        return ""
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith(key + "="):
            return line[len(key) + 1:].strip()
    return ""


class Installer:
    """Holds the state the bash script keeps in globals, and the install steps."""

    def __init__(self) -> None:
        self.profiles: list[str] = []
        self.neo4j_uri = ""
        self.neo4j_password = "gctrl-neo4j-password"
        self.qdrant_url = ""
        self.ollama_base = ""
        self.gpu_enabled = False
        self.gpu_type = "none"  # none | nvidia | amd
        self.chat_model = ""    # chosen generation model ("" = pick later)
        self.vllm_selected = False

    # -- prerequisites --------------------------------------------------------
    def check_prereqs(self) -> None:
        info("Checking prerequisites...")
        missing = [c for c in ("docker",) if not have(c)]
        if run_quiet(["docker", "compose", "version"]) != 0:
            missing.append("docker-compose-plugin")
        if missing:
            die(
                f"Missing: {', '.join(missing)}\n"
                "Install Docker (includes Compose): https://docs.docker.com/engine/install/"
            )
        if run_quiet(["docker", "info"]) != 0:
            warn("Docker daemon not running - please start Docker Desktop...")
            waited = 0
            while run_quiet(["docker", "info"]) != 0:
                time.sleep(3)
                waited += 3
                sys.stdout.write(".")
                sys.stdout.flush()
                if waited >= 60:
                    print()
                    die("Docker is not running after 60s. Start Docker and re-run.")
            print()
        success("Prerequisites OK")

    # -- GPU detection --------------------------------------------------------
    def detect_gpu(self) -> None:
        if have("nvidia-smi") and run_quiet(["nvidia-smi"]) == 0:
            name = self._nvidia_name() or "NVIDIA GPU"
            if have("nvidia-ctk") or self._docker_has_nvidia_runtime():
                self.gpu_enabled, self.gpu_type = True, "nvidia"
                success(f"GPU detected: {name} - KEX will use NVIDIA acceleration")
            else:
                warn(f"NVIDIA GPU found ({name}) but nvidia-container-toolkit is missing - KEX on CPU.")
                info("  Enable later: install nvidia-container-toolkit, then re-run `gctrl update`.")
            return
        # AMD (Linux only): rocm-smi or /dev/kfd
        if platform.system() == "Linux":
            if (have("rocm-smi") and run_quiet(["rocm-smi"]) == 0) or Path("/dev/kfd").exists():
                if Path("/dev/kfd").exists() and Path("/dev/dri").exists():
                    self.gpu_enabled, self.gpu_type = True, "amd"
                    success("GPU detected: AMD - KEX will use ROCm acceleration")
                else:
                    warn("AMD GPU found but /dev/kfd or /dev/dri not accessible - KEX on CPU.")
                return
        info("No discrete GPU detected - KEX will run on CPU")

    @staticmethod
    def _nvidia_name() -> str:
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=gpu_name", "--format=csv,noheader"],
                stderr=subprocess.DEVNULL, text=True,
            )
            return out.strip().splitlines()[0].strip()
        except Exception:
            return ""

    @staticmethod
    def _docker_has_nvidia_runtime() -> bool:
        try:
            out = subprocess.check_output(
                ["docker", "info", "--format", "{{json .Runtimes}}"],
                stderr=subprocess.DEVNULL, text=True,
            )
            return "nvidia" in out.lower()
        except Exception:
            return False

    # -- service detection ----------------------------------------------------
    def detect_services(self) -> None:
        print("\n" + "-" * 46)
        info("Detecting existing infrastructure...\n")

        if probe_tcp(7687):
            self.neo4j_uri = "bolt://host.docker.internal:7687"
            success("Neo4j detected on :7687 - connecting to existing instance")
        else:
            self.profiles.append("bundled-neo4j")
            self.neo4j_uri = "bolt://gctrl-neo4j:7687"
            info("Neo4j not found - deploying bundled container")

        if probe_tcp(6333):
            self.qdrant_url = "http://host.docker.internal:6333"
            success("Qdrant detected on :6333 - connecting to existing instance")
        else:
            self.profiles.append("bundled-qdrant")
            self.qdrant_url = "http://gctrl-qdrant:6333"
            info("Qdrant not found - deploying bundled container")

        if probe_tcp(11434):
            if self._ollama_reachable_from_containers():
                self.ollama_base = "http://host.docker.internal:11434"
                success("Ollama detected on :11434 - connecting to your native instance (GPU-capable)")
            else:
                self.profiles.append("bundled-ollama")
                self.ollama_base = "http://gctrl-ollama:11434"
                warn("Native Ollama listens on localhost only - Docker can't reach it.")
                warn("-> Using the bundled (CPU) Ollama so GCTRL works out of the box.")
                warn("  For GPU: set OLLAMA_HOST=0.0.0.0, then switch in Settings -> AI Models.")
        else:
            self.profiles.append("bundled-ollama")
            self.ollama_base = "http://gctrl-ollama:11434"
            info("Ollama not found - deploying bundled container")

        print()
        if not self.profiles:
            success("All infrastructure already present - connecting to your existing stack")
        else:
            info(f"Will deploy bundled: {' '.join(self.profiles)}")
        print("-" * 46 + "\n")

    @staticmethod
    def _ollama_reachable_from_containers() -> bool:
        """Best-effort: is Ollama bound to all interfaces (containers can reach it)
        or localhost-only? Parse ss/netstat; unknown -> assume reachable (matches bash)."""
        for cmd in (["ss", "-tlnH"], ["netstat", "-tln"], ["netstat", "-an"]):
            if not have(cmd[0]):
                continue
            try:
                out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
            except Exception:
                continue
            lines = [ln for ln in out.splitlines() if ":11434" in ln or ".11434" in ln]
            if not lines:
                continue
            joined = "\n".join(lines)
            if any(b in joined for b in ("0.0.0.0:11434", "*:11434", "[::]:11434", "0.0.0.0.11434")):
                return True
            if "127.0.0.1:11434" in joined or "127.0.0.1.11434" in joined:
                return False
            return True
        return True  # unknown -> assume OK; the dashboard guides the user otherwise

    # -- config generation ----------------------------------------------------
    def generate_config(self) -> None:
        info(f"Creating {INSTALL_DIR}...")
        (INSTALL_DIR / "data").mkdir(parents=True, exist_ok=True)
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        download(COMPOSE_URL, INSTALL_DIR / "docker-compose.yml")
        download(PUBKEY_URL, CONFIG_DIR / "license.pub")
        try:
            (CONFIG_DIR / "license.pub").chmod(0o600)
        except OSError:
            pass  # Windows

        # Secrets: preserved on re-install (a bundled DB bakes auth into its volume
        # on first start - rotating would lock us out), else freshly generated.
        jwt_secret = _read_prev_env("JWT_SECRET") or secrets.token_hex(32)
        pg_pw = _read_prev_env("POSTGRES_PASSWORD") or secrets.token_hex(24)
        internal_secret = _read_prev_env("INTERNAL_API_SECRET") or secrets.token_hex(32)
        if self.neo4j_uri == "bolt://gctrl-neo4j:7687":
            self.neo4j_password = _read_prev_env("NEO4J_PASSWORD") or secrets.token_hex(24)
        vllm_model = _read_prev_env("VLLM_MODEL") or "Qwen/Qwen2.5-3B-Instruct"

        env = "\n".join([
            "GCTRL_API_URL=https://api.gctrl.tech",
            f"GCTRL_DATA_DIR={INSTALL_DIR / 'data'}",
            f"JWT_SECRET={jwt_secret}",
            f"INTERNAL_API_SECRET={internal_secret}",
            f"NEO4J_URI={self.neo4j_uri}",
            f"NEO4J_USER={NEO4J_USER}",
            f"NEO4J_PASSWORD={self.neo4j_password}",
            f"QDRANT_URL={self.qdrant_url}",
            f"OLLAMA_BASE={self.ollama_base}",
            f"RELEX_MODEL={self.chat_model or 'qwen2.5:7b'}",
            f"AUTO_CLASSIFY_MODEL={self.chat_model or 'llama3.2'}",
            f"POSTGRES_PASSWORD={pg_pw}",
            f"VLLM_MODEL={vllm_model}",
            "",
        ])
        (INSTALL_DIR / ".env").write_text(env, encoding="utf-8")
        try:
            (INSTALL_DIR / ".env").chmod(0o600)
        except OSError:
            pass

        if self.gpu_enabled:
            self._write_gpu_override()
        success("Config generated")

    def _write_gpu_override(self) -> None:
        path = INSTALL_DIR / "docker-compose.override.yml"
        if self.gpu_type == "nvidia":
            info("Writing NVIDIA GPU override...")
            path.write_text(_NVIDIA_OVERRIDE, encoding="utf-8")
        elif self.gpu_type == "amd":
            info("Writing AMD ROCm GPU override...")
            path.write_text(_AMD_OVERRIDE, encoding="utf-8")

    # -- hardware.json (Settings -> Infrastructure) ----------------------------
    def detect_hardware(self) -> None:
        hw = {
            "cpu_cores": os.cpu_count() or 0,
            "ram_gb": _ram_gb(),
            "gpu_name": self._nvidia_name(),
            "vram_gb": _nvidia_vram_gb(),
            "nvidia_toolkit": have("nvidia-ctk") or self._docker_has_nvidia_runtime(),
            "arch": _arch(),
            "os": "darwin" if platform.system() == "Darwin" else ("windows" if platform.system() == "Windows" else "linux"),
        }
        (INSTALL_DIR / "hardware.json").write_text(json.dumps(hw, indent=2), encoding="utf-8")
        info(f"Hardware profile written (cpu={hw['cpu_cores']}, ram={hw['ram_gb']}GB, "
             f"gpu='{hw['gpu_name']}', vram={hw['vram_gb']}GB, toolkit={hw['nvidia_toolkit']})")

    # -- model + runtime pickers ----------------------------------------------
    def choose_model(self) -> None:
        env_model = os.environ.get("GCTRL_MODEL")
        if env_model:
            self.chat_model = env_model
            info(f"Model (from GCTRL_MODEL): {self.chat_model}")
            return
        default = "llama3.2:3b"
        if not _interactive():
            self.chat_model = default
            info(f"Non-interactive - default model {self.chat_model} (override: GCTRL_MODEL=...)")
            return
        print("\n" + "-" * 46)
        print("  Choose the local model GCTRL uses for extraction & RAG:")
        print("    1) llama3.2:3b   - lightweight, fast       (~2 GB)  [default]")
        print("    2) qwen2.5:7b    - best extraction quality (~5 GB)")
        print("    3) qwen2.5:14b   - higher quality          (~9 GB, 16 GB+ RAM)")
        print("    4) qwen2.5:32b   - max quality             (~20 GB, 32 GB+ RAM)")
        print("    5) custom        - enter any Ollama tag")
        print("    6) skip          - choose later in the dashboard")
        choice = _ask("  Choice [1]: ") or "1"
        self.chat_model = {
            "1": "llama3.2:3b", "2": "qwen2.5:7b", "3": "qwen2.5:14b",
            "4": "qwen2.5:32b", "6": "",
        }.get(choice, default)
        if choice == "5":
            self.chat_model = _ask("  Ollama model tag: ") or default
        print("-" * 46)
        info(f"Model: {self.chat_model}" if self.chat_model else "Skipping model - pick later in Settings -> Models")
        print()

    def choose_runtime(self) -> None:
        """Offer vLLM only when nvidia_toolkit AND vram_gb >= 8 (mirrors infra.rs gate)."""
        hw_file = INSTALL_DIR / "hardware.json"
        if not hw_file.exists():
            return
        try:
            hw = json.loads(hw_file.read_text(encoding="utf-8"))
        except Exception:
            return
        if not hw.get("nvidia_toolkit"):
            return
        try:
            vram = float(hw.get("vram_gb") or 0)
        except (TypeError, ValueError):
            vram = 0.0
        if vram < 8:
            warn(f"NVIDIA GPU with {vram} GB VRAM < 8 GB - skipping vLLM offer")
            return
        env_rt = os.environ.get("GCTRL_RUNTIME")
        if env_rt:
            if env_rt == "vllm":
                self.vllm_selected = True
                self.profiles.append("bundled-vllm")
                info("Runtime (from GCTRL_RUNTIME): vLLM selected")
            return
        if not _interactive():
            return  # safe default: don't pull the ~10 GB vLLM image unattended
        print("\n" + "-" * 46)
        info(f"NVIDIA GPU with {vram} GB VRAM detected")
        print("    1) No  - use bundled Ollama (default, always works)")
        print("    2) Yes - enable vLLM (pulls vllm/vllm-openai:latest, ~10 GB)")
        if (_ask("  Enable vLLM? [1]: ") or "1") == "2":
            self.vllm_selected = True
            self.profiles.append("bundled-vllm")
            success("vLLM selected - will deploy gctrl-vllm container")
        else:
            info("Keeping bundled Ollama (enable vLLM later in Settings -> Infrastructure)")
        print("-" * 46 + "\n")

    # -- stack lifecycle ------------------------------------------------------
    def _profile_flags(self) -> list[str]:
        flags: list[str] = []
        for p in self.profiles:
            flags += ["--profile", p]
        return flags

    def _compose(self, *args: str) -> list[str]:
        return [
            "docker", "compose",
            "-f", str(INSTALL_DIR / "docker-compose.yml"),
            "--env-file", str(INSTALL_DIR / ".env"),
            *self._profile_flags(), *args,
        ]

    def start_stack(self) -> None:
        info("Starting GCTRL...")
        run(self._compose("pull"))
        run(self._compose("up", "-d"))
        # Persist profiles so `gctrl up/down/logs` reuse them without re-detecting.
        PROFILES_FILE.write_text("\n".join(self.profiles), encoding="utf-8")

        info("Waiting for the web UI (up to 120s)...")
        waited = 0
        while not _http_ok(WEB_URL):
            time.sleep(3)
            waited += 3
            if waited >= 120:
                die(f"Timeout. Check: docker compose -f {INSTALL_DIR / 'docker-compose.yml'} logs")
        success(f"Web UI is live -> {WEB_URL}\n")

    def finalize(self) -> None:
        if self.chat_model:
            self._patch_env_model()
            run(self._compose("up", "-d", "gctrl-kex", "gctrl-fuse"),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("\n" + "-" * 46)
        success("GCTRL is running!\n")
        print(f"  Open {WEB_URL} to activate your license and complete setup")
        print(f"  Installed : {INSTALL_DIR}")
        print(f"  GPU       : {self.gpu_type} acceleration" if self.gpu_enabled else "  GPU       : CPU mode")
        print()
        if "bundled-ollama" in self.profiles:
            self._pull_ollama_models()
        else:
            print(f"  Ollama    : connected at {self.ollama_base}")
        print("-" * 46)

    def _patch_env_model(self) -> None:
        env = INSTALL_DIR / ".env"
        lines = env.read_text(encoding="utf-8").splitlines()
        out = []
        for ln in lines:
            if ln.startswith("RELEX_MODEL="):
                out.append(f"RELEX_MODEL={self.chat_model}")
            elif ln.startswith("AUTO_CLASSIFY_MODEL="):
                out.append(f"AUTO_CLASSIFY_MODEL={self.chat_model}")
            else:
                out.append(ln)
        env.write_text("\n".join(out) + "\n", encoding="utf-8")

    def _pull_ollama_models(self) -> None:
        print("  Ollama    : bundled - pulling required local models (one-time)...")
        models = ["nomic-embed-text"]
        if self.chat_model:
            models = [self.chat_model, *models]
        for m in models:
            print(f"              pulling {m} ...")
            if run_quiet(["docker", "exec", "gctrl-ollama", "ollama", "pull", m]) != 0:
                print(f"              WARN: failed to pull {m} - retry: docker exec gctrl-ollama ollama pull {m}")

    # -- entry point ----------------------------------------------------------
    def install(self) -> None:
        self.check_prereqs()
        self.detect_gpu()
        self.detect_services()
        self.generate_config()
        self.detect_hardware()
        self.choose_runtime()
        self.start_stack()   # bring the stack up FIRST -> UI live at :3001
        self.choose_model()  # ask model question only after the UI is up
        # choose_model may have set chat_model; config was written with placeholders.
        self.finalize()


# -- module-level lifecycle helpers used by `gctrl up/down/...` ----------------
def _saved_profiles() -> list[str]:
    if PROFILES_FILE.exists():
        return [p for p in PROFILES_FILE.read_text(encoding="utf-8").splitlines() if p]
    return []

def _compose_base(*args: str, with_env: bool = True) -> list[str]:
    cmd = ["docker", "compose", "-f", str(INSTALL_DIR / "docker-compose.yml")]
    if with_env and (INSTALL_DIR / ".env").exists():
        cmd += ["--env-file", str(INSTALL_DIR / ".env")]
    for p in _saved_profiles():
        cmd += ["--profile", p]
    return cmd + list(args)

def _require_installed() -> None:
    if not (INSTALL_DIR / "docker-compose.yml").exists():
        die(f"GCTRL is not installed at {INSTALL_DIR}. Run: gctrl install")

def up() -> None:
    _require_installed()
    run(_compose_base("up", "-d"))
    success(f"GCTRL started -> {WEB_URL}")

def down() -> None:
    _require_installed()
    run(_compose_base("down"))
    success("GCTRL stopped")

def status() -> None:
    _require_installed()
    run(_compose_base("ps"))

def logs(follow: bool = True) -> None:
    _require_installed()
    run(_compose_base("logs", *(["-f"] if follow else [])))

def update() -> None:
    """Re-run the installer: re-pulls compose.yml + images, preserves .env/secrets."""
    Installer().install()


# -- platform detection helpers -----------------------------------------------
def _interactive() -> bool:
    return sys.stdin is not None and sys.stdin.isatty()

def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return ""

def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3) as r:  # noqa: S310
            return 200 <= r.status < 500
    except Exception:
        return False

def _arch() -> str:
    m = platform.machine().lower()
    return {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x86_64", "amd64": "x86_64"}.get(m, m or "unknown")

def _ram_gb() -> float:
    try:
        sysname = platform.system()
        if sysname == "Linux" and Path("/proc/meminfo").exists():
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return round(kb / 1048576, 1)
        if sysname == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return round(int(out.strip()) / 1073741824, 1)
        if sysname == "Windows":
            import ctypes
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
            return round(stat.ullTotalPhys / 1073741824, 1)
    except Exception:
        pass
    return 0.0

def _nvidia_vram_gb() -> float:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL, text=True,
        )
        mib = int(out.strip().splitlines()[0].strip())
        return round(mib / 1024, 1)
    except Exception:
        return 0.0


_NVIDIA_OVERRIDE = """\
# Auto-generated by the GCTRL installer - NVIDIA GPU detected.
# Delete this file to switch back to CPU mode, then run: gctrl update
services:
  gctrl-fuse:
    image: ghcr.io/gctrl-tech/fuse:latest-cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
  gctrl-kex:
    image: ghcr.io/gctrl-tech/kex:latest-cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
  gctrl-ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
"""

_AMD_OVERRIDE = """\
# Auto-generated by the GCTRL installer - AMD GPU detected.
# Delete this file to switch back to CPU mode, then run: gctrl update
services:
  gctrl-fuse:
    image: ghcr.io/gctrl-tech/fuse:latest-cuda
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render
  gctrl-kex:
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render
  gctrl-ollama:
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render
"""
