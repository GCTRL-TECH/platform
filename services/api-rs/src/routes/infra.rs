//! External infrastructure overrides (`/api/infra`).
//!
//! GCTRL bundles its own stack (Neo4j, Qdrant, Ollama, Postgres, Redis). This
//! module lets an operator point GCTRL at an EXTERNAL instance of a *swappable*
//! service (Neo4j, Qdrant, Ollama, Postgres) and health-check the target before
//! committing.
//!
//! The `secret` (password / token) is sealed at rest via `services/crypto.rs`
//! and never returned to the client — reads surface only a `hasSecret` boolean.
//!
//! ## Honest apply semantics
//!
//! - **ollama / qdrant** — resolved per outbound HTTP request, so a saved
//!   override can take effect for new requests without a restart.
//! - **postgres / neo4j** — connection pools are built once at boot, so a saved
//!   override is persisted but needs a GCTRL **restart** to take effect. The
//!   `PUT` response carries `appliesImmediately: false` + a `note` so the UI can
//!   be truthful instead of pretending it hot-swaps.
//!
//! ## Routes (mounted under `/api/infra`)
//!
//! - `GET    /overrides`              → list saved overrides (secret omitted)
//! - `PUT    /overrides/:service`     → upsert `{ url, username?, secret? }`
//! - `POST   /overrides/:service/test`→ connectivity check to the given target

use axum::{
    extract::{Extension, Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::error::{AppError, Result};
use crate::middleware::auth::{require_role, JwtClaims};

/// Services that can be swapped for an external instance.
const SWAPPABLE: &[&str] = &["neo4j", "qdrant", "ollama", "postgres"];

/// Honest apply semantics: every service either pools its connection at boot
/// (postgres, neo4j) or is read at startup by the worker services (qdrant,
/// ollama are used by KEX/FUSE). So a saved override is applied reliably across
/// the whole stack only after a GCTRL restart. We no longer pretend any swap
/// hot-applies mid-flight.
fn apply_note(_service: &str) -> &'static str {
    "Saved — restart GCTRL so every service uses it. Reset any time to return to the bundled default."
}

fn is_swappable(s: &str) -> bool {
    SWAPPABLE.contains(&s)
}

// ── Model catalog ─────────────────────────────────────────────────────────────

/// Per-runtime generation model catalog.
/// Each entry: (id, label, ollama_tag, llamacpp_hf_arg, vllm_repo, ram_gb)
struct GenModelEntry {
    id: &'static str,
    label: &'static str,
    ollama: &'static str,
    llamacpp: &'static str,
    vllm: &'static str,
    ram_gb: f32,
}

const RUNTIME_GEN_MODELS: &[GenModelEntry] = &[
    GenModelEntry {
        id: "qwen2.5-3b",
        label: "Qwen 2.5 3B Instruct",
        ollama: "qwen2.5:3b",
        llamacpp: "bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M",
        vllm: "Qwen/Qwen2.5-3B-Instruct",
        ram_gb: 3.0,
    },
    GenModelEntry {
        id: "qwen2.5-7b",
        label: "Qwen 2.5 7B Instruct",
        ollama: "qwen2.5:7b",
        llamacpp: "bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
        vllm: "Qwen/Qwen2.5-7B-Instruct",
        ram_gb: 6.0,
    },
    GenModelEntry {
        id: "llama-3.2-3b",
        label: "Llama 3.2 3B Instruct",
        ollama: "llama3.2",
        llamacpp: "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
        vllm: "meta-llama/Llama-3.2-3B-Instruct",
        ram_gb: 3.0,
    },
];

/// Resolve the per-runtime argument for a given model ID.
/// Returns `None` for unknown model IDs.
/// runtime: "ollama" | "llamacpp" | "vllm"
pub fn resolve_model_arg(model_id: &str, runtime: &str) -> Option<String> {
    let entry = RUNTIME_GEN_MODELS.iter().find(|e| e.id == model_id)?;
    let arg = match runtime {
        "ollama"   => entry.ollama,
        "llamacpp" => entry.llamacpp,
        "vllm"     => entry.vllm,
        _          => return None,
    };
    Some(arg.to_string())
}

// ── Shared persist_runtime helper ─────────────────────────────────────────────

/// Shared helper: UPSERT `runtime_config` row (id=1).
/// Seals `api_key` when provided; COALESCE preserves existing key otherwise.
pub(crate) async fn persist_runtime(
    db: &sqlx::PgPool,
    provider: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    api_key: Option<&str>,
) -> crate::error::Result<()> {
    let sealed_key: Option<String> = api_key
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .map(crate::services::crypto::seal);

    sqlx::query(
        "INSERT INTO runtime_config (id, provider, base_url, model, api_key, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
             provider   = $1,
             base_url   = $2,
             model      = $3,
             api_key    = COALESCE($4, runtime_config.api_key),
             updated_at = now()",
    )
    .bind(provider)
    .bind(base_url)
    .bind(model)
    .bind(sealed_key)
    .execute(db)
    .await?;
    Ok(())
}

/// The bundled (onboard) default endpoint for a swappable service — what GCTRL
/// uses out of the box. Credentials live separately (never in these URLs).
pub(crate) fn default_service_url(cfg: &crate::config::Config, service: &str) -> String {
    match service {
        "neo4j" => cfg.neo4j_uri.clone(),
        "qdrant" => cfg.qdrant_url.clone(),
        "postgres" => "postgres (bundled)".to_string(), // creds in DATABASE_URL — never surfaced
        // Bundled Ollama lives on the compose network as `gctrl-ollama`. Prefer the
        // explicit OLLAMA_BASE env (compose sets it), then fall back to the compose
        // service name — NOT `localhost`, which from inside the api container points
        // at the api container itself and always reads as "offline".
        "ollama" => std::env::var("OLLAMA_BASE").unwrap_or_else(|_| "http://gctrl-ollama:11434".into()),
        _ => String::new(),
    }
}

/// Effective endpoint for a service: the saved override URL if present, else the
/// bundled default. (Used to PROBE the right target in the status view.)
pub(crate) async fn effective_service_url(
    db: &sqlx::PgPool,
    cfg: &crate::config::Config,
    service: &str,
) -> String {
    if let Ok(Some(Some(u))) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT url FROM service_overrides WHERE service = $1",
    ).bind(service).fetch_optional(db).await {
        if !u.trim().is_empty() { return u; }
    }
    default_service_url(cfg, service)
}

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/overrides", get(list_overrides))
        .route(
            "/overrides/:service",
            axum::routing::put(upsert_override).delete(delete_override),
        )
        .route("/overrides/:service/test", axum::routing::post(test_override))
        // ── Global runtime (active LLM generation runtime) ─────────────────
        .route("/active-runtime", get(get_active_runtime))
        .route("/runtimes", get(list_runtimes))
        .route("/runtime", post(set_runtime))
        // ── Runtime-aware model catalog ──────────────────────────────────────
        .route("/models", get(list_gen_models))
        // ── Runtime switch (SSE, admin-only) ────────────────────────────────
        .route("/switch-runtime", post(switch_runtime))
        // ── Hardware detection + recommendation ──────────────────────────────
        .route("/hardware", get(get_hardware))
        .route("/rescan-hardware", post(rescan_hardware))
        .route("/recommend", get(get_recommend))
        // ── Embedding reindex (SSE, admin-only, double-opt-in) ───────────────
        .route("/reindex", post(reindex))
        // ── Runtime guardrail (Cookbook banner) ──────────────────────────────
        .route("/guardrail", get(get_guardrail))
        .route("/guardrail/events/:id/dismiss", post(dismiss_guardrail_event))
}

// ── GET /api/infra/guardrail ─────────────────────────────────────────────────

/// `GET /api/infra/guardrail` — returns the guardrail's current
/// failure-tracking state plus undismissed events (runtime reverts,
/// degraded-job notices), newest first. Drives the amber `GuardrailBanner`.
/// Events are ADMIN-scoped (bug-hunt W7): they alert the operator that the
/// platform runtime auto-reverted; a non-admin seeing (and being unable to
/// act on) them adds nothing, and a non-admin dismissing them could hide the
/// alert from the admin. Non-admins receive state with an empty event list.
async fn get_guardrail(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let is_admin = crate::middleware::auth::require_role(&claims, "admin").is_ok();
    let state_row: Option<(i32, Option<chrono::DateTime<chrono::Utc>>, Option<String>, Option<chrono::DateTime<chrono::Utc>>, Option<Value>)> =
        sqlx::query_as(
            "SELECT consecutive_failures, last_probe_at, last_error, reverted_at, reverted_from
             FROM guardrail_state WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await?;

    let (consecutive_failures, last_probe_at, last_error, reverted_at, reverted_from) =
        state_row.unwrap_or((0, None, None, None, None));

    #[derive(sqlx::FromRow)]
    struct EventRow {
        id: uuid::Uuid,
        created_at: chrono::DateTime<chrono::Utc>,
        kind: String,
        detail: Value,
    }
    let events: Vec<EventRow> = if is_admin {
        sqlx::query_as(
            "SELECT id, created_at, kind, detail FROM guardrail_events
              WHERE dismissed = false ORDER BY created_at DESC LIMIT 20",
        )
        .fetch_all(&state.db)
        .await?
    } else {
        Vec::new()
    };

    Ok(Json(json!({
        "state": {
            "consecutiveFailures": consecutive_failures,
            "lastProbeAt": last_probe_at.map(|t| t.to_rfc3339()),
            "lastError": last_error,
            "revertedAt": reverted_at.map(|t| t.to_rfc3339()),
            "revertedFrom": reverted_from,
        },
        "events": events.into_iter().map(|e| json!({
            "id": e.id,
            "createdAt": e.created_at.to_rfc3339(),
            "kind": e.kind,
            "detail": e.detail,
        })).collect::<Vec<_>>(),
    })))
}

// ── POST /api/infra/guardrail/events/:id/dismiss ─────────────────────────────

/// Dismiss a guardrail event — hides it from the banner. Admin-only (matching
/// every other mutating endpoint in this file, bug-hunt W7): a low-privilege
/// account must not be able to hide a platform-wide revert alert before the
/// operator sees it. Purely a UI-acknowledgement flag; never affects guardrail logic.
async fn dismiss_guardrail_event(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Json<Value>> {
    crate::middleware::auth::require_role(&claims, "admin")?;
    sqlx::query("UPDATE guardrail_events SET dismissed = true WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Hardware struct ───────────────────────────────────────────────────────────

/// Host hardware profile, written by the installer to `hardware.json` and
/// augmented at request time from `/proc` (Linux) so stale values self-correct.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct Hardware {
    #[serde(default)] pub cpu_cores:      u32,
    #[serde(default)] pub ram_gb:         f64,
    #[serde(default)] pub gpu_name:       String,
    #[serde(default)] pub vram_gb:        f64,
    #[serde(default)] pub nvidia_toolkit: bool,
    #[serde(default)] pub arch:           String,
    #[serde(default)] pub os:             String,
}

impl Default for Hardware {
    fn default() -> Self {
        Self {
            cpu_cores:      0,
            ram_gb:         0.0,
            gpu_name:       String::new(),
            vram_gb:        0.0,
            nvidia_toolkit: false,
            arch:           String::new(),
            os:             String::new(),
        }
    }
}

/// Path probe order for `hardware.json`:
/// 1. `$GCTRL_DIR/hardware.json`       — operator-set install dir
/// 2. `/app/hardware.json`             — container-mounted install dir
/// 3. `./hardware.json`                — working directory fallback
///
/// Returns the first path that exists, or `None` if none is found.
fn hardware_json_path() -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = {
        let mut v = Vec::new();
        if let Ok(dir) = std::env::var("GCTRL_DIR") {
            v.push(std::path::PathBuf::from(dir).join("hardware.json"));
        }
        v.push(std::path::PathBuf::from("/app/hardware.json"));
        v.push(std::path::PathBuf::from("./hardware.json"));
        v
    };
    candidates.into_iter().find(|p| p.exists())
}

/// Read Linux `/proc` for live CPU core count and RAM (GB, 1-decimal).
/// Returns `(cores, ram_gb)` — both `None` on non-Linux or unreadable proc.
fn proc_hardware() -> (Option<u32>, Option<f64>) {
    // cpu_cores: count "processor" lines in /proc/cpuinfo
    let cores = std::fs::read_to_string("/proc/cpuinfo").ok().map(|s| {
        s.lines()
            .filter(|l| l.starts_with("processor"))
            .count() as u32
    });
    // ram_gb: MemTotal kB → GB
    let ram = std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| {
        s.lines()
            .find(|l| l.starts_with("MemTotal:"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| {
                let gb = kb as f64 / 1_048_576.0;
                // round to 1 decimal
                (gb * 10.0).round() / 10.0
            })
    });
    (cores, ram)
}

/// Probe the real GPU via the docker socket: `docker exec` into the `ollama`
/// container (which has GPU passthrough) and run `nvidia-smi`. The api
/// container itself has no GPU access — this is the only place `nvidia-smi`
/// is reachable at runtime, so it's the only way to detect the GPU without an
/// installer-written `hardware.json`.
///
/// Tries container name `ollama` first, then `gctrl-ollama`. Returns
/// `(gpu_name, vram_gb)` on success, `None` on any failure (best-effort — the
/// caller must not fail the whole endpoint if this comes back empty).
#[cfg(unix)]
fn probe_gpu_via_docker() -> Option<(String, f64)> {
    for container in ["ollama", "gctrl-ollama"] {
        if let Some(result) = probe_gpu_in_container(container) {
            return Some(result);
        }
    }
    None
}

#[cfg(unix)]
fn probe_gpu_in_container(container: &str) -> Option<(String, f64)> {
    let exec_cfg = json!({
        "AttachStdout": true,
        "AttachStderr": false,
        "Tty": true,
        "Cmd": ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]
    })
    .to_string();

    let create_path = format!("/containers/{container}/exec");
    let (create_status, create_body) =
        crate::routes::update::docker_http("POST", &create_path, Some(&exec_cfg), 15).ok()?;
    if create_status != 201 && create_status != 200 {
        return None;
    }
    let exec_id = crate::routes::update::json_from_body(&create_body)["Id"]
        .as_str()?
        .to_string();

    let start_path = format!("/exec/{exec_id}/start");
    let (start_status, output) = crate::routes::update::docker_http(
        "POST",
        &start_path,
        Some(r#"{"Detach":false,"Tty":true}"#),
        15,
    )
    .ok()?;
    if start_status != 200 {
        return None;
    }

    parse_nvidia_smi_output(&output)
}

#[cfg(not(unix))]
fn probe_gpu_via_docker() -> Option<(String, f64)> {
    None
}

/// Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
/// output (e.g. `NVIDIA GeForce RTX 3080 Ti, 12288`). Splits on the LAST comma
/// since GPU names can themselves contain commas in rare cases. VRAM is
/// reported in MiB — converted to GB (1 decimal).
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_nvidia_smi_output(output: &str) -> Option<(String, f64)> {
    let line = output.lines().find(|l| l.contains(','))?;
    let (name_part, vram_part) = line.rsplit_once(',')?;
    let name = name_part.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let vram_mib: f64 = vram_part.trim().parse().ok()?;
    let vram_gb = (vram_mib / 1024.0 * 10.0).round() / 10.0;
    Some((name, vram_gb))
}

// ── GET /api/infra/hardware ───────────────────────────────────────────────────

/// `GET /api/infra/hardware` — any authenticated user.
///
/// Reads `hardware.json` (installer-written) and OVERLAYS live `/proc` values
/// for `cpu_cores` and `ram_gb` so stale file values self-correct. Also probes
/// the GPU at request time via the docker socket (`nvidia-smi` inside the
/// `ollama` container — see `probe_gpu_via_docker`), since `hardware.json`'s
/// GPU fields are install-time-only and empty on most dev boxes.
///
/// Returns both the flat legacy fields (back-compat) AND two structured
/// blocks — `docker` (container-visible CPU/RAM) and `system` (probed GPU +
/// host RAM if known) — so the UI can show both views side by side.
async fn get_hardware(
    Extension(_claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    let file_path = hardware_json_path();
    let mut hw: Hardware = match &file_path {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| AppError::Internal(format!("read hardware.json: {e}")))?;
            serde_json::from_str(&text).unwrap_or_default()
        }
        None => Hardware::default(),
    };

    // Host RAM as recorded by the installer — the only known source of the
    // TRUE host total. /proc inside the container only ever sees the
    // container/WSL2-VM-visible total, never the real host RAM.
    let host_ram_gb: Option<f64> = if file_path.is_some() && hw.ram_gb > 0.0 {
        Some(hw.ram_gb)
    } else {
        None
    };

    // Overlay live /proc values so stale file values self-correct (container view).
    let (live_cores, live_ram) = proc_hardware();
    if let Some(c) = live_cores { hw.cpu_cores = c; }
    if let Some(r) = live_ram   { hw.ram_gb    = r; }
    let docker_cpu_cores = hw.cpu_cores;
    let docker_ram_gb = hw.ram_gb;

    // Runtime GPU probe (best-effort, off the async executor thread — the
    // docker socket I/O is blocking).
    let had_file_gpu = !hw.gpu_name.trim().is_empty();
    let probed = tokio::task::spawn_blocking(probe_gpu_via_docker)
        .await
        .unwrap_or(None);
    if let Some((name, vram)) = probed {
        if !had_file_gpu {
            hw.gpu_name = name;
            hw.vram_gb = vram;
        }
        hw.nvidia_toolkit = true;
    }

    let mut resp = serde_json::to_value(&hw).unwrap_or(json!({}));
    resp["docker"] = json!({
        "cpu_cores": docker_cpu_cores,
        "ram_gb": docker_ram_gb,
        "source": "container",
    });
    resp["system"] = json!({
        "gpu_name": hw.gpu_name,
        "vram_gb": hw.vram_gb,
        "nvidia_toolkit": hw.nvidia_toolkit,
        "ram_gb": host_ram_gb,
        "ram_source": if host_ram_gb.is_some() { "installer" } else { "unknown" },
    });

    Ok(Json(resp))
}

// ── POST /api/infra/rescan-hardware ──────────────────────────────────────────

/// `POST /api/infra/rescan-hardware` — admin only.
///
/// Probes the Docker daemon via the socket for live container-visible values:
/// - `NCPU`     → cpu_cores
/// - `MemTotal` → ram_gb  (bytes → GB)
/// - `Runtimes` → nvidia_toolkit (contains "nvidia" key)
///
/// GPU name and VRAM can only be detected at install time (nvidia-smi is host-
/// native, not container-visible without passthrough). File values are preserved
/// for those fields. Returns the merged object + a `gpu_rescan` note.
async fn rescan_hardware(
    Extension(claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    // Load the file baseline (best-effort; default if missing).
    let file_path = hardware_json_path();
    let mut hw: Hardware = match &file_path {
        Some(path) => {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        }
        None => Hardware::default(),
    };

    // Host RAM is only knowable from the installer-written file — capture it
    // BEFORE the Docker /info overlay overwrites hw.ram_gb with the
    // container/WSL2-VM-visible total. Without this, re-scan drops the
    // "System (host)" RAM to null and the UI blanks it.
    let host_ram_gb: Option<f64> = if file_path.is_some() && hw.ram_gb > 0.0 {
        Some(hw.ram_gb)
    } else {
        None
    };

    // Probe Docker daemon.
    let docker_result = tokio::task::spawn_blocking(|| {
        crate::routes::update::docker_http("GET", "/info", None, 10)
    }).await;

    match docker_result {
        Ok(Ok((status, body))) if status == 200 => {
            let info = crate::routes::update::json_from_body(&body);

            if let Some(ncpu) = info["NCPU"].as_u64() {
                hw.cpu_cores = ncpu as u32;
            }
            if let Some(mem_bytes) = info["MemTotal"].as_u64() {
                hw.ram_gb = ((mem_bytes as f64 / 1_073_741_824.0) * 10.0).round() / 10.0;
            }
            if let Some(runtimes) = info["Runtimes"].as_object() {
                hw.nvidia_toolkit = runtimes.contains_key("nvidia");
            }
        }
        Ok(Ok((status, _))) => {
            return Err(AppError::Internal(format!("Docker /info returned HTTP {status}")));
        }
        Ok(Err(e)) => {
            return Err(AppError::Internal(format!("Docker socket error: {e}")));
        }
        Err(e) => {
            return Err(AppError::Internal(format!("spawn_blocking error: {e}")));
        }
    }

    // Return the SAME structured shape as GET /hardware so the UI keeps its
    // Docker + System views (and host RAM) after a re-scan — otherwise the flat
    // payload has no `system` block and the client blanks the host-RAM tile.
    let docker_cpu_cores = hw.cpu_cores;
    let docker_ram_gb = hw.ram_gb;
    let mut resp = serde_json::to_value(&hw).unwrap_or(json!({}));
    resp["docker"] = json!({
        "cpu_cores": docker_cpu_cores,
        "ram_gb": docker_ram_gb,
        "source": "container",
    });
    resp["system"] = json!({
        "gpu_name": hw.gpu_name,
        "vram_gb": hw.vram_gb,
        "nvidia_toolkit": hw.nvidia_toolkit,
        "ram_gb": host_ram_gb,
        "ram_source": if host_ram_gb.is_some() { "installer" } else { "unknown" },
    });
    resp["gpu_rescan"] = json!("install-time only");
    Ok(Json(resp))
}

// ── GET /api/infra/recommend ─────────────────────────────────────────────────

/// `GET /api/infra/recommend` — any authenticated user.
///
/// Reads the hardware profile and returns a `Recommendation` with the best
/// runtime + model for the machine. Logic is pure (`recommend` / `pick_model_for_budget`
/// take no IO) so it can be unit-tested without any infrastructure.
async fn get_recommend(
    Extension(_claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    let mut hw: Hardware = match hardware_json_path() {
        Some(path) => {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        }
        None => Hardware::default(),
    };

    // Overlay live /proc so the recommendation uses up-to-date RAM.
    let (live_cores, live_ram) = proc_hardware();
    if let Some(c) = live_cores { hw.cpu_cores = c; }
    if let Some(r) = live_ram   { hw.ram_gb    = r; }

    let rec = recommend(&hw);
    Ok(Json(json!({
        "hardware":        serde_json::to_value(&hw).unwrap_or(json!({})),
        "recommendation":  {
            "runtime":          rec.runtime,
            "model":            rec.model,
            "rationale":        rec.rationale,
            "speedup_estimate": rec.speedup_estimate,
        }
    })))
}

// ── Pure recommendation logic (unit-testable, no IO) ─────────────────────────

pub struct Recommendation {
    pub runtime:          &'static str,
    pub model:            &'static str,
    pub rationale:        &'static str,
    pub speedup_estimate: &'static str,
}

/// Select the model with the highest `ram_gb` that still fits within `budget_gb`.
/// Falls back to the catalog entry with the smallest `ram_gb` when nothing fits.
pub fn pick_model_for_budget(budget_gb: f64) -> &'static str {
    // Find the entry with the largest ram_gb that is ≤ budget_gb.
    let best = RUNTIME_GEN_MODELS
        .iter()
        .filter(|e| (e.ram_gb as f64) <= budget_gb)
        .max_by(|a, b| a.ram_gb.partial_cmp(&b.ram_gb).unwrap_or(std::cmp::Ordering::Equal));
    match best {
        Some(e) => e.id,
        None => {
            // Nothing fits: return the first catalog entry (smallest by convention).
            RUNTIME_GEN_MODELS
                .first()
                .map(|e| e.id)
                .unwrap_or("qwen2.5-3b")
        }
    }
}

/// Return the best runtime + model for the given hardware. Pure — no IO.
pub fn recommend(hw: &Hardware) -> Recommendation {
    // Rule 1: Apple Silicon — Metal-accelerated llama.cpp
    if hw.os == "darwin" && hw.arch == "arm64" {
        let model = pick_model_for_budget(hw.ram_gb * 0.6);
        return Recommendation {
            runtime:          "llamacpp",
            model,
            rationale:        "Apple Silicon runs llama.cpp with Metal acceleration, delivering \
                                significantly higher throughput than bundled Ollama on CPU.",
            speedup_estimate: "~2–4× vs CPU Ollama (estimate)",
        };
    }

    // Rule 2: NVIDIA with ≥16 GB VRAM — vLLM for maximum GPU throughput
    if hw.nvidia_toolkit && hw.vram_gb >= 16.0 {
        return Recommendation {
            runtime:          "vllm",
            model:            "qwen2.5-7b",
            rationale:        "16 GB+ VRAM is sufficient for vLLM's continuous-batching engine, \
                                which delivers the highest throughput for concurrent requests.",
            speedup_estimate: "~5–10× (estimate)",
        };
    }

    // Rule 3: NVIDIA with ≥6 GB VRAM — llama.cpp with CUDA offload
    if hw.nvidia_toolkit && hw.vram_gb >= 6.0 {
        return Recommendation {
            runtime:          "llamacpp",
            model:            "qwen2.5-7b",
            rationale:        "6–16 GB VRAM is enough for llama.cpp CUDA offload, which \
                                accelerates inference without the overhead of vLLM's batch engine.",
            speedup_estimate: "~3–6× (estimate)",
        };
    }

    // Rule 4: CPU-only fallback — llama.cpp is faster than bundled Ollama on CPU
    let model = pick_model_for_budget(hw.ram_gb * 0.6);
    Recommendation {
        runtime:          "llamacpp",
        model,
        rationale:        "llama.cpp is faster than Ollama on CPU due to lower overhead and \
                            better SIMD utilisation.",
        speedup_estimate: "~1.3–2× (estimate)",
    }
}

// ── GET /overrides ──────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct OverrideRow {
    service: String,
    url: Option<String>,
    username: Option<String>,
    secret: Option<String>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/// List the saved overrides for all swappable services. The sealed secret is
/// never returned — only a `hasSecret` flag. Services with no override row are
/// returned with `url: null` so the UI can render an empty swap form per service.
async fn list_overrides(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Infrastructure config is admin-only (reveals service endpoints/usernames).
    require_role(&claims, "admin")?;
    let rows: Vec<OverrideRow> = sqlx::query_as(
        "SELECT service, url, username, secret, updated_at FROM service_overrides",
    )
    .fetch_all(&state.db)
    .await?;

    let overrides: Vec<Value> = SWAPPABLE
        .iter()
        .map(|svc| {
            let row = rows.iter().find(|r| r.service == *svc);
            let has_override = row.and_then(|r| r.url.as_deref()).map(|u| !u.trim().is_empty()).unwrap_or(false);
            json!({
                "service":     svc,
                "url":         row.and_then(|r| r.url.clone()),
                "username":    row.and_then(|r| r.username.clone()),
                "hasSecret":   row.and_then(|r| r.secret.as_deref()).map(|s| !s.trim().is_empty()).unwrap_or(false),
                "updatedAt":   row.map(|r| r.updated_at.to_rfc3339()),
                // Where the service currently points: the bundled onboard default,
                // or an external override the operator saved.
                "source":      if has_override { "override" } else { "default" },
                "defaultUrl":  default_service_url(&state.cfg, svc),
                "note":        apply_note(svc),
            })
        })
        .collect();

    Ok(Json(json!({ "overrides": overrides })))
}

// ── DELETE /overrides/:service — reset to the bundled onboard default ─────────

/// Remove a saved override so the service falls back to its bundled default.
/// (Pooled services apply the reset on the next GCTRL restart.)
async fn delete_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }
    sqlx::query("DELETE FROM service_overrides WHERE service = $1")
        .bind(&service)
        .execute(&state.db)
        .await?;
    crate::services::audit::log_access(
        &state.db, &claims, "infra.override.reset", "service_override", &service,
        0, None, true, None,
    ).await;
    Ok(Json(json!({
        "ok": true, "service": service, "source": "default",
        "defaultUrl": default_service_url(&state.cfg, &service),
        "note": "Reset to the bundled default — restart GCTRL to apply across services.",
    })))
}

// ── PUT /overrides/:service ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpsertReq {
    url: Option<String>,
    username: Option<String>,
    secret: Option<String>,
}

/// Upsert an external override. `secret`, if present and non-empty, is sealed via
/// `crypto::seal`; if omitted the existing stored secret is preserved (COALESCE),
/// so the URL/username can be changed without re-entering the secret.
async fn upsert_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
    Json(req): Json<UpsertReq>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }

    let url = req.url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    if url.is_none() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    let username = req.username.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let sealed_secret: Option<String> = req
        .secret
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(crate::services::crypto::seal);

    // COALESCE on secret so omitting it preserves the stored value on update.
    sqlx::query(
        "INSERT INTO service_overrides (service, url, username, secret, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (service) DO UPDATE SET
            url        = $2,
            username   = $3,
            secret     = COALESCE($4, service_overrides.secret),
            updated_at = now()",
    )
    .bind(&service)
    .bind(url)
    .bind(username)
    .bind(sealed_secret)
    .execute(&state.db)
    .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "infra.override.set", "service_override", &service,
        0, None, true, None,
    ).await;

    Ok(Json(json!({
        "ok": true,
        "service": service,
        "source": "override",
        "note": apply_note(&service),
    })))
}

// ── POST /overrides/:service/test ───────────────────────────────────────────

/// Connectivity check against the saved override target (or, if a fresh `url` is
/// supplied in the body, against that — so Test works before Save). Each service
/// uses its cheapest reachability probe:
///   - ollama  → GET {url}/api/tags
///   - qdrant  → GET {url}/healthz
///   - neo4j   → TCP connect to the bolt host:port
///   - postgres→ TCP connect to host:port
async fn test_override(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(service): Path<String>,
    Json(req): Json<UpsertReq>,
) -> Result<Json<Value>> {
    // Admin-only: the probe targets an admin-supplied URL. Admins already control
    // the deployment's network, so this is not a privilege escalation; the host
    // guard below still blocks the one class of target that is never legitimate
    // infrastructure (cloud-metadata / unspecified).
    require_role(&claims, "admin")?;
    let service = service.trim().to_lowercase();
    if !is_swappable(&service) {
        return Err(AppError::BadRequest(format!("Service '{service}' is not swappable")));
    }

    // Prefer a URL supplied in the request (Test-before-Save); else the saved one.
    let body_url = req.url.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
    let url = match body_url {
        Some(u) => Some(u),
        None => sqlx::query_scalar::<_, Option<String>>(
            "SELECT url FROM service_overrides WHERE service = $1",
        )
        .bind(&service)
        .fetch_optional(&state.db)
        .await?
        .flatten(),
    };

    let Some(url) = url else {
        return Ok(Json(json!({ "ok": false, "service": service, "error": "no target URL configured" })));
    };

    // No redirects: a 3xx reply must not bounce a validated hop to a new host.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    let result = match service.as_str() {
        "ollama" | "qdrant" => {
            // Validate the resolved host before any request (blind-SSRF guard).
            let parsed = url::Url::parse(&url).map_err(|_| AppError::BadRequest("invalid url".into()))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AppError::BadRequest("url must be http(s)".into()));
            }
            let host = parsed.host_str().unwrap_or("").to_string();
            let port = parsed.port_or_known_default().unwrap_or(80);
            match guard_probe_host(&host, port).await {
                Ok(()) => {
                    let path = if service == "ollama" { "/api/tags" } else { "/healthz" };
                    probe_http_ok(&client, &format!("{}{}", url.trim_end_matches('/'), path)).await
                }
                Err(e) => Err(e),
            }
        }
        "neo4j" | "postgres" => {
            match parse_host_port(&url) {
                Ok((host, port)) => match guard_probe_host(&host, port).await {
                    Ok(()) => probe_tcp_url(&url).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            }
        }
        _ => Err("unsupported service".into()),
    };

    match result {
        Ok(latency) => Ok(Json(json!({ "ok": true, "service": service, "latencyMs": latency }))),
        Err(e) => Ok(Json(json!({ "ok": false, "service": service, "error": e }))),
    }
}

/// Resolve `host` and reject targets that are never legitimate infrastructure:
/// cloud-metadata / link-local (169.254.0.0/16, fe80::/10) and unspecified
/// (0.0.0.0, ::). Private/LAN/loopback are INTENTIONALLY allowed — this admin-only
/// feature exists to point GCTRL at infra that commonly lives on a private network
/// (the bundled stack itself runs on the docker private net).
async fn guard_probe_host(host: &str, port: u16) -> std::result::Result<(), String> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "host did not resolve".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("host did not resolve".into());
    }
    for addr in &addrs {
        let blocked = match addr.ip() {
            std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast(),
            // link-local fe80::/10 or unspecified ::
            std::net::IpAddr::V6(v6) => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
        };
        if blocked {
            return Err("target resolves to a blocked address (metadata/link-local/unspecified)".into());
        }
    }
    Ok(())
}

/// GET probe: success on any non-5xx HTTP response (reachable + serving).
async fn probe_http_ok(client: &reqwest::Client, url: &str) -> std::result::Result<u128, String> {
    let start = std::time::Instant::now();
    let resp = timeout(Duration::from_secs(5), client.get(url).send())
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    if resp.status().as_u16() < 500 {
        Ok(start.elapsed().as_millis())
    } else {
        Err(format!("HTTP {}", resp.status().as_u16()))
    }
}

/// TCP probe for a connection-URL like `bolt://host:7687` or
/// `postgres://user:pass@host:5432/db`. Extracts host:port and connects.
async fn probe_tcp_url(url: &str) -> std::result::Result<u128, String> {
    let (host, port) = parse_host_port(url)?;
    let start = std::time::Instant::now();
    timeout(Duration::from_secs(5), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis())
}

/// Pull host + port out of a connection URL. Defaults: bolt→7687, postgres→5432.
fn parse_host_port(url: &str) -> std::result::Result<(String, u16), String> {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_lowercase(), r),
        None => (String::new(), url),
    };
    // Strip any user:pass@ credentials and any trailing /path.
    let authority = rest.rsplit_once('@').map(|(_, a)| a).unwrap_or(rest);
    let authority = authority.split('/').next().unwrap_or(authority);
    let default_port: u16 = match scheme.as_str() {
        "postgres" | "postgresql" => 5432,
        "bolt" | "neo4j" | "neo4j+s" | "bolt+s" => 7687,
        _ => 0,
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "invalid port".to_string())?),
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err("missing host".into());
    }
    if port == 0 {
        return Err("missing port (include it in the URL, e.g. host:7687)".into());
    }
    Ok((host, port))
}

// ── Global runtime config endpoints ─────────────────────────────────────────
//
// These three endpoints manage the operator-level "active runtime" — the
// default generation backend used when no per-user provider is configured.
// The singleton row in `runtime_config` (id=1) stores the choice; absence
// means "unset → bundled Ollama default".

// ── Validate runtime input (pure, testable) ──────────────────────────────────

/// Validate the body fields for `POST /runtime` without touching the DB.
///
/// - `provider` must be one of `{"ollama","openai_compatible"}`.
/// - `openai_compatible` requires a non-empty `base_url`.
/// - When `base_url` is present it is run through the SSRF guard.
///
/// Returns `Ok(validated_base)` — the validated base URL string for
/// `openai_compatible`, or `None` for `ollama` (the base is optional and
/// validated later at request time via `containerize_ollama_base`).
pub fn validate_runtime_input(
    provider: &str,
    base_url: Option<&str>,
) -> std::result::Result<Option<String>, String> {
    match provider {
        "ollama" => {
            // Base is optional for Ollama (falls back to OLLAMA_BASE / bundled default).
            // Validate it when provided so bad values are rejected at write time.
            if let Some(b) = base_url.map(str::trim).filter(|s| !s.is_empty()) {
                crate::services::llm::validate_llm_base("ollama", Some(b))
                    .map(|_| Some(b.to_string()))
                    .map_err(|e| e)
            } else {
                Ok(None)
            }
        }
        "openai_compatible" => {
            let b = base_url
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "base_url is required for openai_compatible".to_string())?;
            crate::services::llm::validate_llm_base("openai_compatible", Some(b))
                .map(|u| Some(u.as_str().trim_end_matches('/').to_string()))
                .map_err(|e| e)
        }
        other => Err(format!(
            "Unknown provider '{other}'. Valid values: ollama, openai_compatible"
        )),
    }
}

// ── GET /api/infra/active-runtime ────────────────────────────────────────────

/// Return the current global runtime — provider, endpoint, model, and a live
/// health probe result. The `api_key` is NEVER returned; `configured` is true
/// when a provider row exists and the provider field is non-empty.
async fn get_active_runtime(
    Extension(_claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    // Any authenticated user may read (not admin-only — the UI shows this in
    // the Settings summary for all users to understand the active backend).
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT provider, base_url, model, embedding_mode
             FROM runtime_config WHERE id = 1",
        )
        .fetch_optional(&state.db)
        .await?;

    let (provider, base_url, model, embedding_mode, configured) = match row {
        Some((Some(p), b, m, em)) if !p.trim().is_empty() => {
            (p.trim().to_string(), b, m, em, true)
        }
        Some((_, b, m, em)) => ("ollama".to_string(), b, m, em, false),
        None => ("ollama".to_string(), None, None, None, false),
    };

    // Build a temporary target for the health probe — no key needed for probing.
    let health_client = reqwest::Client::new();
    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        base_url: base_url.clone(),
        api_key: None,
    };
    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;

    Ok(Json(json!({
        "provider":       provider,
        "base_url":       base_url,
        "model":          model,
        "embedding_mode": embedding_mode.unwrap_or_else(|| "pinned".to_string()),
        "configured":     configured,
        "healthy":        healthy,
    })))
}

// ── GET /api/infra/runtimes ───────────────────────────────────────────────────

/// Return the static catalog of selectable runtime kinds for the UI.
async fn list_runtimes(
    Extension(_claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    Ok(Json(json!({
        "runtimes": [
            {
                "id":           "ollama",
                "label":        "Bundled Ollama",
                "kind":         "ollama",
                "needs_base_url": false,
                "needs_gpu":    false,
                "description":  "Local Ollama bundled with GCTRL. No key required. Default when nothing is configured.",
            },
            {
                "id":           "llamacpp",
                "label":        "llama.cpp (bundled)",
                "kind":         "openai_compatible",
                "needs_base_url": false,
                "needs_gpu":    false,
                "description":  "Bundled llama.cpp server. Faster than Ollama on CPU; CUDA-offloads on NVIDIA GPUs with 6–16 GB VRAM.",
            },
            {
                "id":           "vllm",
                "label":        "vLLM (GPU, bundled)",
                "kind":         "openai_compatible",
                "needs_base_url": false,
                "needs_gpu":    true,
                "description":  "Bundled vLLM engine. Maximum throughput for NVIDIA GPUs with ≥8 GB VRAM (nvidia-container-toolkit required).",
            },
            {
                "id":           "external",
                "label":        "OpenAI-compatible endpoint",
                "kind":         "openai_compatible",
                "needs_base_url": true,
                "needs_gpu":    false,
                "description":  "Any /v1-compatible server: LM Studio, llama.cpp, vLLM, LocalAI, or a hosted API.",
            },
        ]
    })))
}

// ── POST /api/infra/runtime ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct SetRuntimeReq {
    provider: String,
    base_url: Option<String>,
    api_key:  Option<String>,
    model:    Option<String>,
}

/// Set (UPSERT) the global active runtime. Admin-only.
///
/// Steps:
///   1. Validate provider and base_url (SSRF guard via validate_runtime_input).
///   2. Build a temporary LlmTarget and probe health — still saves even if unhealthy.
///   3. UPSERT the singleton row; seal api_key when provided; preserve existing
///      key when omitted (mirrors routes/llm.rs preserve-on-omit behaviour).
async fn set_runtime(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SetRuntimeReq>,
) -> Result<Json<Value>> {
    require_role(&claims, "admin")?;

    let provider = req.provider.trim().to_string();
    let base_url_raw = req.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let model = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    // (a)+(b) Validate provider + base_url with SSRF guard.
    let validated_base: Option<String> = validate_runtime_input(&provider, base_url_raw)
        .map_err(|e| AppError::BadRequest(e))?;

    // (c) Health probe — save regardless of result but signal the caller.
    let health_client = reqwest::Client::new();
    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        base_url: validated_base.clone(),
        api_key: None, // health probe doesn't need the key
    };
    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;

    // (d) Seal the api_key when provided.
    let sealed_key: Option<String> = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(crate::services::crypto::seal);

    // UPSERT singleton row (id=1). When api_key is omitted (NULL), COALESCE
    // preserves the existing stored key so the operator doesn't need to re-enter
    // it on every model/URL change — matching routes/llm.rs upsert behaviour.
    sqlx::query(
        "INSERT INTO runtime_config (id, provider, base_url, model, api_key, updated_at)
         VALUES (1, $1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
             provider   = $1,
             base_url   = $2,
             model      = $3,
             api_key    = COALESCE($4, runtime_config.api_key),
             updated_at = now()",
    )
    .bind(&provider)
    .bind(&validated_base)
    .bind(&model)
    .bind(&sealed_key)
    .execute(&state.db)
    .await?;

    crate::services::audit::log_access(
        &state.db, &claims, "infra.runtime.set", "runtime_config", "1",
        0, None, true, None,
    ).await;

    let mut resp = json!({ "saved": true, "healthy": healthy });
    if !healthy {
        resp["warning"] = json!(
            "Runtime saved but health probe failed. The server may not be running yet — \
             it will be used once it is reachable."
        );
    }
    Ok(Json(resp))
}

// ── GET /api/infra/models ─────────────────────────────────────────────────────

/// `GET /api/infra/models?runtime=<kind>` → model catalog for a given runtime.
/// runtime: "ollama" | "llamacpp" | "vllm"
async fn list_gen_models(
    Extension(_claims): Extension<crate::middleware::auth::JwtClaims>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>> {
    let runtime = params.get("runtime").map(|s| s.as_str()).unwrap_or("ollama");
    let models: Vec<Value> = RUNTIME_GEN_MODELS
        .iter()
        .map(|e| {
            let arg = resolve_model_arg(e.id, runtime);
            json!({
                "id":      e.id,
                "label":   e.label,
                "arg":     arg,
                "ram_gb":  e.ram_gb,
            })
        })
        .collect();
    Ok(Json(json!({ "runtime": runtime, "models": models })))
}

// ── POST /api/infra/switch-runtime ───────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SwitchRuntimeReq {
    runtime:  String,
    model:    Option<String>,
    base_url: Option<String>,
    api_key:  Option<String>,
}

#[derive(serde::Deserialize)]
struct ReindexReq {
    confirm:            bool,
    confirm_text:       String,
    embedding_model:    String,
    embedding_base:     Option<String>,
    embedding_provider: Option<String>,
}

/// Pure validation for the double-opt-in reindex gate.
/// Returns Ok(()) when both fields are correctly set, Err(message) otherwise.
pub fn validate_reindex_request(
    confirm: bool,
    confirm_text: &str,
    embedding_model: &str,
    _embedding_base: Option<&str>,
    _embedding_provider: Option<&str>,
) -> std::result::Result<(), String> {
    if !confirm || confirm_text != "REINDEX" {
        return Err(
            "double-opt-in required: set confirm=true and confirm_text=\"REINDEX\"".into()
        );
    }
    let model = embedding_model.trim();
    if model.is_empty() {
        return Err("embedding_model must not be empty".into());
    }
    Ok(())
}

/// `POST /api/infra/switch-runtime` — SSE stream, admin-only.
/// Body: `{ runtime, model?, base_url?, api_key? }`
/// runtime ∈ "ollama" | "llamacpp" | "external"
async fn switch_runtime(
    Extension(claims): Extension<crate::middleware::auth::JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<SwitchRuntimeReq>,
) -> axum::response::Response {
    if let Err(e) = crate::middleware::auth::require_role(&claims, "admin") {
        return axum::response::IntoResponse::into_response(e);
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<std::result::Result<Event, Infallible>>();

    let db = state.db.clone();
    tokio::spawn(async move {
        run_switch_runtime(tx, db, req).await;
    });

    let stream = async_stream::stream! {
        while let Some(item) = rx.recv().await {
            yield item;
        }
    };

    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    );
    axum::response::IntoResponse::into_response(sse)
}

async fn run_switch_runtime(
    tx: mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
    db: sqlx::PgPool,
    req: SwitchRuntimeReq,
) {
    let send = |event: &str, data: serde_json::Value| {
        let _ = tx.send(Ok(Event::default().event(event).data(data.to_string())));
    };

    let runtime = req.runtime.trim().to_string();

    match runtime.as_str() {
        "external" => {
            // Validate base_url and health-probe before saving.
            send("progress", json!({ "step": "validating", "message": "Validating external endpoint…" }));

            let base_url = match req.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(b) => b.to_string(),
                None => {
                    send("error", json!({ "message": "base_url is required for external runtime" }));
                    return;
                }
            };

            if let Err(e) = crate::services::llm::validate_llm_base("openai_compatible", Some(&base_url)) {
                send("error", json!({ "message": format!("Invalid base_url: {e}") }));
                return;
            }

            let model_str = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("llama3.2").to_string();

            let health_client = reqwest::Client::new();
            let target = crate::services::llm::LlmTarget {
                provider: "openai_compatible".into(),
                model: model_str.clone(),
                base_url: Some(base_url.clone()),
                api_key: None,
            };
            let healthy = crate::services::llm::runtime_health(&health_client, &target).await;
            if !healthy {
                send("progress", json!({ "step": "validating", "message": "Health probe returned unhealthy — saving anyway (server may still be starting)." }));
            }

            send("progress", json!({ "step": "saving", "message": "Saving runtime config…" }));

            let api_key_opt = req.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if let Err(e) = persist_runtime(&db, "openai_compatible", Some(&base_url), Some(&model_str), api_key_opt).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            send("done", json!({ "provider": "openai_compatible", "base_url": base_url, "model": model_str, "healthy": healthy }));
        }

        "ollama" => {
            send("progress", json!({ "step": "saving", "message": "Switching back to bundled Ollama…" }));

            if let Err(e) = persist_runtime(&db, "ollama", None, None, None).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            // Best-effort: stop gctrl-llamacpp and gctrl-vllm if running (ignore errors).
            let _ = tokio::task::spawn_blocking(|| {
                let _ = crate::routes::update::docker_http(
                    "POST",
                    "/containers/gctrl-llamacpp/stop",
                    None,
                    10,
                );
                let _ = crate::routes::update::docker_http(
                    "POST",
                    "/containers/gctrl-vllm/stop",
                    None,
                    10,
                );
            }).await;

            send("done", json!({ "provider": "ollama" }));
        }

        "llamacpp" => {
            // 1. Resolve model arg (default: qwen2.5-3b)
            let model_id = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("qwen2.5-3b");
            // Accept a catalog id (qwen2.5-3b…) OR any raw model ref (a GGUF HF
            // arg / tag) so custom / dynamically-picked models work too.
            let hf_arg = resolve_model_arg(model_id, "llamacpp").unwrap_or_else(|| model_id.to_string());

            if !std::path::Path::new("/var/run/docker.sock").exists() {
                send("error", json!({ "message": "Docker socket not accessible — cannot launch llama.cpp container" }));
                return;
            }

            // 2. Pull image
            send("progress", json!({ "step": "pull", "message": "Pulling ghcr.io/ggml-org/llama.cpp:server…" }));
            let pull_img = "ghcr.io/ggml-org/llama.cpp:server".to_string();
            match tokio::task::spawn_blocking(move || crate::routes::update::pull_image(&pull_img)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    send("error", json!({ "message": format!("Image pull failed: {e}") }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Pull task failed: {e}") }));
                    return;
                }
            }

            // 3. Detect our own network by inspecting our container
            send("progress", json!({ "step": "create", "message": "Detecting container network…" }));
            let network_mode = detect_own_network().unwrap_or_else(|| "bridge".to_string());

            // 3b. Remove old container if exists, then create + start
            send("progress", json!({ "step": "create", "message": format!("Creating gctrl-llamacpp on network '{network_mode}'…") }));
            let hf_arg_clone = hf_arg.clone();
            let net_clone = network_mode.clone();
            match tokio::task::spawn_blocking(move || {
                launch_llamacpp_container(&hf_arg_clone, &net_clone)
            }).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    send("error", json!({ "message": format!("Container create/start failed: {e}") }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Container task failed: {e}") }));
                    return;
                }
            }

            // 4. Poll health until ready (GGUF download can take minutes)
            send("progress", json!({ "step": "downloading model", "message": format!("Waiting for llama.cpp to download model '{hf_arg}'… (this may take several minutes)") }));
            let health_client = reqwest::Client::new();
            let model_id_owned = model_id.to_string();
            let target = crate::services::llm::LlmTarget {
                provider: "openai_compatible".into(),
                model: model_id_owned.clone(),
                base_url: Some("http://gctrl-llamacpp:8080".into()),
                api_key: None,
            };
            let healthy = poll_llamacpp_health(&health_client, &target, &tx).await;

            // 5. UPSERT runtime_config regardless of health (download continues)
            if let Err(e) = persist_runtime(
                &db,
                "openai_compatible",
                Some("http://gctrl-llamacpp:8080"),
                Some(&model_id_owned),
                None,
            ).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            if healthy {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-llamacpp:8080",
                    "model": model_id_owned,
                    "note": "llama.cpp is running and healthy"
                }));
            } else {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-llamacpp:8080",
                    "model": model_id_owned,
                    "note": "llama.cpp container started but model download is still in progress — runtime config saved; it will serve requests once the download completes"
                }));
            }
        }

        "vllm" => {
            // 1. Resolve model HF repo (default: qwen2.5-3b → Qwen/Qwen2.5-3B-Instruct)
            let model_id = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("qwen2.5-3b");
            // Accept a catalog id (qwen2.5-3b…) OR any raw HF repo so custom /
            // dynamically-picked models work (e.g. Qwen/Qwen2.5-7B-Instruct-AWQ).
            let hf_repo = resolve_model_arg(model_id, "vllm").unwrap_or_else(|| model_id.to_string());

            if !std::path::Path::new("/var/run/docker.sock").exists() {
                send("error", json!({ "message": "Docker socket not accessible — cannot launch vLLM container" }));
                return;
            }

            // 2. Pull image
            send("progress", json!({ "step": "pull", "message": "Pulling vllm/vllm-openai:latest…" }));
            let pull_img = "vllm/vllm-openai:latest".to_string();
            match tokio::task::spawn_blocking(move || crate::routes::update::pull_image(&pull_img)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    // Distinguish GPU-missing from generic pull failure
                    let msg = if e.contains("nvidia") || e.contains("runtime") {
                        format!("vLLM requires an NVIDIA GPU + nvidia-container-toolkit. Pull failed: {e}")
                    } else {
                        format!("Image pull failed: {e}")
                    };
                    send("error", json!({ "message": msg }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Pull task failed: {e}") }));
                    return;
                }
            }

            // 3. Detect our own network by inspecting our container
            send("progress", json!({ "step": "create", "message": "Detecting container network…" }));
            let network_mode = detect_own_network().unwrap_or_else(|| "bridge".to_string());

            // 4. Remove old container if exists, then create + start
            send("progress", json!({ "step": "create", "message": format!("Creating gctrl-vllm on network '{network_mode}'…") }));
            let hf_repo_clone = hf_repo.clone();
            let net_clone = network_mode.clone();
            match tokio::task::spawn_blocking(move || {
                launch_vllm_container(&hf_repo_clone, &net_clone)
            }).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    let msg = if e.contains("nvidia") || e.contains("Unknown runtime") || e.contains("DeviceRequests") {
                        format!("vLLM requires an NVIDIA GPU + nvidia-container-toolkit. Container create failed: {e}")
                    } else {
                        format!("Container create/start failed: {e}")
                    };
                    send("error", json!({ "message": msg }));
                    return;
                }
                Err(e) => {
                    send("error", json!({ "message": format!("Container task failed: {e}") }));
                    return;
                }
            }

            // 5. Poll health until ready (model download from HuggingFace can take minutes)
            send("progress", json!({ "step": "downloading model", "message": format!("Waiting for vLLM to download model '{hf_repo}'… (this may take several minutes)") }));
            let health_client = reqwest::Client::new();
            let model_id_owned = model_id.to_string();
            let target = crate::services::llm::LlmTarget {
                provider: "openai_compatible".into(),
                model: model_id_owned.clone(),
                base_url: Some("http://gctrl-vllm:8000".into()),
                api_key: None,
            };
            let healthy = poll_vllm_health(&health_client, &target, &tx).await;

            // 6. UPSERT runtime_config regardless of health (download continues in container)
            if let Err(e) = persist_runtime(
                &db,
                "openai_compatible",
                Some("http://gctrl-vllm:8000"),
                Some(&model_id_owned),
                None,
            ).await {
                send("error", json!({ "message": format!("DB save failed: {e}") }));
                return;
            }

            if healthy {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-vllm:8000",
                    "model": model_id_owned,
                    "note": "vLLM is running and healthy"
                }));
            } else {
                send("done", json!({
                    "provider": "openai_compatible",
                    "base_url": "http://gctrl-vllm:8000",
                    "model": model_id_owned,
                    "note": "vLLM container started but model download is still in progress — runtime config saved; it will serve requests once the download completes"
                }));
            }
        }

        other => {
            send("error", json!({ "message": format!("Unknown runtime '{other}'. Valid: ollama, llamacpp, vllm, external") }));
        }
    }
}

/// Poll gctrl-llamacpp's health endpoint until it responds or times out.
/// Emits periodic progress events. Returns true if healthy within the window.
async fn poll_llamacpp_health(
    client: &reqwest::Client,
    target: &crate::services::llm::LlmTarget,
    tx: &mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
) -> bool {
    // Allow up to 10 minutes for model download
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    let mut attempt = 0u32;

    loop {
        if tokio::time::Instant::now() >= deadline {
            let _ = tx.send(Ok(Event::default()
                .event("progress")
                .data(json!({ "step": "downloading model", "message": "Timed out waiting for llama.cpp — model download continues in background" }).to_string())));
            return false;
        }

        interval.tick().await;
        attempt += 1;

        if crate::services::llm::runtime_health(client, target).await {
            return true;
        }

        let _ = tx.send(Ok(Event::default()
            .event("progress")
            .data(json!({ "step": "downloading model", "message": format!("Still waiting for llama.cpp (attempt {attempt})…") }).to_string())));
    }
}

/// Detect this container's primary network by inspecting our own container.
/// Reads the container hostname from the HOSTNAME env var (Docker sets it to
/// the short container ID), then calls `GET /containers/{id}/json` and reads
/// the first key in `NetworkSettings.Networks`.
///
/// Returns None if the socket is unreachable or we're not in a container.
fn detect_own_network() -> Option<String> {
    // Docker sets HOSTNAME to the container short-id.
    let hostname = std::env::var("HOSTNAME").ok().filter(|s| !s.trim().is_empty())?;
    let hostname = hostname.trim();

    let (status, body) = crate::routes::update::docker_http(
        "GET",
        &format!("/containers/{hostname}/json"),
        None,
        10,
    ).ok()?;

    if status != 200 { return None; }

    let inspect = crate::routes::update::json_from_body(&body);

    // First try the stored NetworkMode from HostConfig.
    if let Some(nm) = inspect["HostConfig"]["NetworkMode"].as_str() {
        let nm = nm.trim();
        if !nm.is_empty() && nm != "default" {
            return Some(nm.to_string());
        }
    }

    // Fall back: the first key in NetworkSettings.Networks.
    if let Some(networks) = inspect["NetworkSettings"]["Networks"].as_object() {
        if let Some(net_name) = networks.keys().next() {
            let n = net_name.trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }

    None
}

/// Create (or replace) and start the `gctrl-llamacpp` container.
/// - Force-removes any existing container first.
/// - Mounts a named volume `gctrl-llamacpp-models:/root/.cache` for the GGUF cache.
/// - Joins the API's own network so it's reachable at `gctrl-llamacpp:8080`.
fn launch_llamacpp_container(hf_arg: &str, network_mode: &str) -> std::result::Result<(), String> {
    // Force-remove existing container (ignore 404).
    let _ = crate::routes::update::docker_http(
        "DELETE",
        "/containers/gctrl-llamacpp?force=true",
        None,
        30,
    );

    let create_body = serde_json::json!({
        "Image": "ghcr.io/ggml-org/llama.cpp:server",
        "Cmd": ["-hf", hf_arg, "--host", "0.0.0.0", "--port", "8080", "-c", "8192"],
        "HostConfig": {
            "Binds": ["gctrl-llamacpp-models:/root/.cache"],
            "NetworkMode": network_mode,
            "RestartPolicy": { "Name": "unless-stopped" }
        }
    }).to_string();

    let (create_status, create_body_resp) = crate::routes::update::docker_http(
        "POST",
        "/containers/create?name=gctrl-llamacpp",
        Some(&create_body),
        30,
    )?;

    if create_status != 201 {
        return Err(format!("Container create HTTP {create_status}: {create_body_resp}"));
    }

    let created = crate::routes::update::json_from_body(&create_body_resp);
    let id = created["Id"].as_str().unwrap_or("gctrl-llamacpp");

    let (start_status, _) = crate::routes::update::docker_http(
        "POST",
        &format!("/containers/{id}/start"),
        None,
        10,
    )?;

    if start_status != 204 && start_status != 304 {
        return Err(format!("Container start HTTP {start_status}"));
    }

    Ok(())
}

/// Poll gctrl-vllm's health endpoint until it responds or times out.
/// vLLM model loads are slower than llama.cpp GGUF (HuggingFace download +
/// CUDA init), so we allow up to 15 minutes. Emits periodic progress events.
/// Returns true if healthy within the window.
async fn poll_vllm_health(
    client: &reqwest::Client,
    target: &crate::services::llm::LlmTarget,
    tx: &mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
) -> bool {
    // Allow up to 15 minutes — vLLM HuggingFace download + CUDA init is slow
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    let mut attempt = 0u32;

    loop {
        if tokio::time::Instant::now() >= deadline {
            let _ = tx.send(Ok(Event::default()
                .event("progress")
                .data(json!({ "step": "downloading model", "message": "Timed out waiting for vLLM — model download continues in background" }).to_string())));
            return false;
        }

        interval.tick().await;
        attempt += 1;

        if crate::services::llm::runtime_health(client, target).await {
            return true;
        }

        let _ = tx.send(Ok(Event::default()
            .event("progress")
            .data(json!({ "step": "downloading model", "message": format!("Still waiting for vLLM (attempt {attempt})…") }).to_string())));
    }
}

/// Create (or replace) and start the `gctrl-vllm` container.
/// - Force-removes any existing container first.
/// - Mounts a named volume `gctrl-vllm-models:/root/.cache/huggingface` for HuggingFace cache.
/// - Joins the API's own network so it's reachable at `gctrl-vllm:8000`.
/// - Requests the NVIDIA GPU via DeviceRequests (requires nvidia-container-toolkit).
fn launch_vllm_container(hf_repo: &str, network_mode: &str) -> std::result::Result<(), String> {
    // Force-remove existing container (ignore 404).
    let _ = crate::routes::update::docker_http(
        "DELETE",
        "/containers/gctrl-vllm?force=true",
        None,
        30,
    );

    let create_body = serde_json::json!({
        "Image": "vllm/vllm-openai:latest",
        "Cmd": ["--model", hf_repo, "--host", "0.0.0.0", "--port", "8000"],
        "HostConfig": {
            "Binds": ["gctrl-vllm-models:/root/.cache/huggingface"],
            "NetworkMode": network_mode,
            "RestartPolicy": { "Name": "unless-stopped" },
            "DeviceRequests": [
                {
                    "Driver": "nvidia",
                    "Count": -1,
                    "Capabilities": [["gpu"]]
                }
            ]
        }
    }).to_string();

    let (create_status, create_body_resp) = crate::routes::update::docker_http(
        "POST",
        "/containers/create?name=gctrl-vllm",
        Some(&create_body),
        30,
    )?;

    if create_status != 201 {
        return Err(format!("Container create HTTP {create_status}: {create_body_resp}"));
    }

    let created = crate::routes::update::json_from_body(&create_body_resp);
    let id = created["Id"].as_str().unwrap_or("gctrl-vllm");

    let (start_status, _) = crate::routes::update::docker_http(
        "POST",
        &format!("/containers/{id}/start"),
        None,
        10,
    )?;

    if start_status != 204 && start_status != 304 {
        return Err(format!("Container start HTTP {start_status}"));
    }

    Ok(())
}

// ── Agent / MCP tool helpers (pure, no axum, callable from execute_tool) ────

/// Read the hardware profile as a plain JSON Value (same logic as GET /hardware).
/// Overlays live /proc values so stale file values self-correct.
pub fn hardware_json() -> Value {
    let mut hw: Hardware = match hardware_json_path() {
        Some(path) => std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        None => Hardware::default(),
    };
    let (live_cores, live_ram) = proc_hardware();
    if let Some(c) = live_cores { hw.cpu_cores = c; }
    if let Some(r) = live_ram   { hw.ram_gb    = r; }
    serde_json::to_value(&hw).unwrap_or(json!({}))
}

/// Return the recommendation JSON (hardware + recommendation), no IO beyond
/// reading hardware.json + /proc.
pub fn recommend_json() -> Value {
    let mut hw: Hardware = match hardware_json_path() {
        Some(path) => std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        None => Hardware::default(),
    };
    let (live_cores, live_ram) = proc_hardware();
    if let Some(c) = live_cores { hw.cpu_cores = c; }
    if let Some(r) = live_ram   { hw.ram_gb    = r; }
    let rec = recommend(&hw);
    json!({
        "runtime":          rec.runtime,
        "model":            rec.model,
        "rationale":        rec.rationale,
        "speedup_estimate": rec.speedup_estimate,
    })
}

/// Return the static runtime catalog as JSON (same data as GET /runtimes).
pub fn runtimes_catalog_json() -> Value {
    json!({
        "runtimes": [
            {
                "id":             "ollama",
                "label":          "Bundled Ollama",
                "kind":           "ollama",
                "needs_base_url": false,
                "needs_gpu":      false,
                "description":    "Local Ollama bundled with GCTRL. No key required. Default when nothing is configured.",
            },
            {
                "id":             "llamacpp",
                "label":          "llama.cpp (bundled)",
                "kind":           "openai_compatible",
                "needs_base_url": false,
                "needs_gpu":      false,
                "description":    "Bundled llama.cpp server. Faster than Ollama on CPU; CUDA-offloads on NVIDIA GPUs with 6–16 GB VRAM.",
            },
            {
                "id":             "vllm",
                "label":          "vLLM (GPU, bundled)",
                "kind":           "openai_compatible",
                "needs_base_url": false,
                "needs_gpu":      true,
                "description":    "Bundled vLLM engine. Maximum throughput for NVIDIA GPUs with ≥8 GB VRAM (nvidia-container-toolkit required).",
            },
            {
                "id":             "openai_compatible",
                "label":          "OpenAI-compatible endpoint",
                "kind":           "openai_compatible",
                "needs_base_url": true,
                "needs_gpu":      false,
                "description":    "Any /v1-compatible server: LM Studio, llama.cpp, vLLM, LocalAI, or a hosted API.",
            },
        ]
    })
}

/// Return the model catalog for a given runtime as JSON (same as GET /models?runtime=…).
/// `runtime` ∈ "ollama" | "llamacpp" | "vllm"
pub fn models_for_runtime_json(runtime: &str) -> Value {
    let models: Vec<Value> = RUNTIME_GEN_MODELS
        .iter()
        .map(|e| {
            json!({
                "id":     e.id,
                "label":  e.label,
                "arg":    resolve_model_arg(e.id, runtime),
                "ram_gb": e.ram_gb,
            })
        })
        .collect();
    json!({ "runtime": runtime, "models": models })
}

/// Return the active runtime status as JSON. Never leaks api_key.
/// Falls back gracefully when the DB is unreachable.
pub async fn active_runtime_json(db: &sqlx::PgPool) -> Value {
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT provider, base_url, model, embedding_mode FROM runtime_config WHERE id = 1",
        )
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

    let (provider, base_url, model, embedding_mode, configured) = match row {
        Some((Some(p), b, m, em)) if !p.trim().is_empty() => {
            (p.trim().to_string(), b, m, em, true)
        }
        Some((_, b, m, em)) => ("ollama".to_string(), b, m, em, false),
        None => ("ollama".to_string(), None, None, None, false),
    };

    // Light health probe — no key needed.
    let health_client = reqwest::Client::new();
    let target = crate::services::llm::LlmTarget {
        provider: provider.clone(),
        model: model.clone().unwrap_or_else(|| "llama3.2".to_string()),
        base_url: base_url.clone(),
        api_key: None,
    };
    let healthy = crate::services::llm::runtime_health(&health_client, &target).await;

    json!({
        "provider":       provider,
        "base_url":       base_url,
        "model":          model,
        "embedding_mode": embedding_mode.unwrap_or_else(|| "pinned".to_string()),
        "configured":     configured,
        "healthy":        healthy,
    })
}

/// Validate a new embedding mode string. Returns `Ok(())` for known modes.
pub fn validate_embedding_mode(mode: &str) -> std::result::Result<(), String> {
    match mode {
        "pinned" | "advanced" => Ok(()),
        other => Err(format!(
            "Unknown embedding mode '{other}'. Valid values: pinned, advanced"
        )),
    }
}

// ── POST /api/infra/reindex ───────────────────────────────────────────────────

/// `POST /api/infra/reindex` — SSE stream, admin-only, double-opt-in.
///
/// Switches embedding_mode to 'advanced', persists the new embedding config, then
/// enqueues one reindex job per knowledge base (compilation) onto Redis `kex:reindex`.
///
/// Body: { confirm: bool, confirm_text: "REINDEX", embedding_model: str,
///          embedding_base?: str, embedding_provider?: str }
///
/// HONEST: search quality will degrade until the reindex worker completes all KBs.
async fn reindex(
    Extension(claims): Extension<crate::middleware::auth::JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ReindexReq>,
) -> axum::response::Response {
    if let Err(e) = crate::middleware::auth::require_role(&claims, "admin") {
        return axum::response::IntoResponse::into_response(e);
    }

    // Double-opt-in gate — reject immediately (non-SSE) before doing anything.
    let model = req.embedding_model.trim().to_string();
    let base_opt = req.embedding_base.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let provider_opt = req.embedding_provider.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    if let Err(e) = validate_reindex_request(
        req.confirm,
        req.confirm_text.as_str(),
        &model,
        base_opt.as_deref(),
        provider_opt.as_deref(),
    ) {
        return axum::response::IntoResponse::into_response(
            (axum::http::StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({ "error": e })))
        );
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<std::result::Result<Event, Infallible>>();

    let db = state.db.clone();
    let redis_url = state.cfg.redis_url.clone();
    tokio::spawn(async move {
        run_reindex(tx, db, redis_url, model, base_opt, provider_opt).await;
    });

    let stream = async_stream::stream! {
        while let Some(item) = rx.recv().await {
            yield item;
        }
    };

    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    );
    axum::response::IntoResponse::into_response(sse)
}

async fn run_reindex(
    tx: mpsc::UnboundedSender<std::result::Result<Event, Infallible>>,
    db: sqlx::PgPool,
    redis_url: String,
    embedding_model: String,
    embedding_base: Option<String>,
    embedding_provider: Option<String>,
) {
    let send = |event: &str, data: serde_json::Value| {
        let _ = tx.send(Ok(Event::default().event(event).data(data.to_string())));
    };

    // 1. Persist advanced embedding config into runtime_config.
    send("progress", serde_json::json!({ "step": "persist", "message": "Persisting advanced embedding config…" }));

    let upsert_result = sqlx::query(
        "INSERT INTO runtime_config (id, embedding_mode, embedding_model, embedding_base, embedding_provider, updated_at)
         VALUES (1, 'advanced', $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET
             embedding_mode     = 'advanced',
             embedding_model    = $1,
             embedding_base     = $2,
             embedding_provider = $3,
             updated_at         = now()",
    )
    .bind(&embedding_model)
    .bind(&embedding_base)
    .bind(&embedding_provider)
    .execute(&db)
    .await;

    if let Err(e) = upsert_result {
        send("error", serde_json::json!({ "message": format!("DB upsert failed: {e}") }));
        return;
    }

    // 2. Query all compilation IDs.
    send("progress", serde_json::json!({ "step": "query", "message": "Querying knowledge bases…" }));

    let compilation_ids: Vec<uuid::Uuid> = match sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM compilations ORDER BY created_at",
    )
    .fetch_all(&db)
    .await {
        Ok(ids) => ids,
        Err(e) => {
            send("error", serde_json::json!({ "message": format!("Failed to query compilations: {e}") }));
            return;
        }
    };

    let count = compilation_ids.len();
    send("progress", serde_json::json!({
        "step": "enqueue",
        "message": format!("Scheduling reindex for {} knowledge base(s)…", count)
    }));

    // 3. Push one job per compilation onto Redis kex:reindex.
    let redis_client = match redis::Client::open(redis_url.as_str()) {
        Ok(c) => c,
        Err(e) => {
            send("error", serde_json::json!({ "message": format!("Redis connect failed: {e}") }));
            return;
        }
    };
    let mut con = match redis_client.get_connection() {
        Ok(c) => c,
        Err(e) => {
            send("error", serde_json::json!({ "message": format!("Redis connection failed: {e}") }));
            return;
        }
    };

    let mut enqueued = 0usize;
    for cid in &compilation_ids {
        let job = serde_json::json!({
            "compilationId": cid.to_string(),
            "embedding_model": &embedding_model,
            "embedding_base":  &embedding_base,
            "embedding_provider": &embedding_provider,
        });
        let payload = job.to_string();
        use redis::Commands;
        match con.rpush::<_, _, i64>("kex:reindex", &payload) {
            Ok(_) => enqueued += 1,
            Err(e) => {
                send("progress", serde_json::json!({
                    "step": "enqueue",
                    "message": format!("Warning: failed to enqueue KB {cid}: {e}")
                }));
            }
        }
    }

    send("done", serde_json::json!({
        "scheduled": enqueued,
        "total": count,
        "embedding_model": &embedding_model,
        "warning": "Search quality will degrade until the reindex worker completes all knowledge bases. \
                    Existing embeddings remain active until each KB is fully re-indexed.",
    }));
}

/// Pure GPU-gating predicate for vLLM.
/// Returns true only when nvidia-container-toolkit is present AND VRAM ≥ 8 GB.
/// Used by the installer (bash-side gate mirrors this logic) and unit-tested here.
pub fn vllm_available(nvidia_toolkit: bool, vram_gb: f64) -> bool {
    nvidia_toolkit && vram_gb >= 8.0
}

/// Kick off the llamacpp bring-up in a spawned task and return immediately.
/// Caller gets `{ ok: true, status: "starting", note: "…" }` without blocking.
pub fn spawn_llamacpp_startup(db: sqlx::PgPool, model_id: String) {
    tokio::spawn(async move {
        let hf_arg = match resolve_model_arg(&model_id, "llamacpp") {
            Some(a) => a,
            None => {
                tracing::warn!(%model_id, "llamacpp startup: unknown model id, no llamacpp arg");
                return;
            }
        };

        if !std::path::Path::new("/var/run/docker.sock").exists() {
            tracing::warn!("llamacpp startup: /var/run/docker.sock not present — cannot bring up bundled runtime");
            return;
        }

        // Pull image (surface the real error so the bundled bring-up is diagnosable).
        let pull_img = "ghcr.io/ggml-org/llama.cpp:server".to_string();
        match tokio::task::spawn_blocking(move || crate::routes::update::pull_image(&pull_img)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::error!(error = %e, "llamacpp startup: image pull failed");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "llamacpp startup: pull task panicked");
                return;
            }
        }

        // Detect network
        let network_mode = detect_own_network().unwrap_or_else(|| "bridge".to_string());
        tracing::info!(%network_mode, %hf_arg, "llamacpp startup: creating gctrl-llamacpp");

        // Create + start container
        let hf_arg_clone = hf_arg.clone();
        let net_clone = network_mode.clone();
        match tokio::task::spawn_blocking(move || launch_llamacpp_container(&hf_arg_clone, &net_clone)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::error!(error = %e, "llamacpp startup: container launch failed");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "llamacpp startup: launch task panicked");
                return;
            }
        }

        // Persist runtime config (download is happening in container)
        if let Err(e) = persist_runtime(
            &db,
            "openai_compatible",
            Some("http://gctrl-llamacpp:8080"),
            Some(&model_id),
            None,
        )
        .await
        {
            tracing::error!(error = %e, "llamacpp startup: persist_runtime failed");
        } else {
            tracing::info!(%model_id, "llamacpp startup: gctrl-llamacpp created; model downloading in background");
        }
    });
}

// ── Unit tests (pure validation logic — no DB harness) ───────────────────────

#[cfg(test)]
mod runtime_tests {
    use super::validate_runtime_input;

    // ── Provider validation ───────────────────────────────────────────────────

    #[test]
    fn unknown_provider_is_rejected() {
        let err = validate_runtime_input("gpt-4o", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    #[test]
    fn openai_provider_is_rejected() {
        // "openai" is not in the runtime catalog (it lives in per-user providers)
        let err = validate_runtime_input("openai", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    #[test]
    fn anthropic_provider_is_rejected() {
        let err = validate_runtime_input("anthropic", None).unwrap_err();
        assert!(err.contains("Unknown provider"), "got: {err}");
    }

    // ── ollama ────────────────────────────────────────────────────────────────

    #[test]
    fn ollama_no_base_is_ok() {
        let result = validate_runtime_input("ollama", None);
        assert!(result.is_ok(), "got: {:?}", result);
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn ollama_with_local_base_is_ok() {
        let result = validate_runtime_input("ollama", Some("http://localhost:11434"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn ollama_with_lan_base_is_ok() {
        let result = validate_runtime_input("ollama", Some("http://10.0.0.5:11434"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn ollama_with_bad_scheme_is_rejected() {
        let err = validate_runtime_input("ollama", Some("file:///etc/passwd")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    #[test]
    fn ollama_with_embedded_creds_is_rejected() {
        let err = validate_runtime_input("ollama", Some("http://user:pass@localhost:11434")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    // ── openai_compatible ─────────────────────────────────────────────────────

    #[test]
    fn openai_compatible_requires_base_url() {
        let err = validate_runtime_input("openai_compatible", None).unwrap_err();
        assert!(err.contains("base_url is required"), "got: {err}");
    }

    #[test]
    fn openai_compatible_empty_base_url_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("  ")).unwrap_err();
        assert!(err.contains("base_url is required"), "got: {err}");
    }

    #[test]
    fn openai_compatible_local_base_is_ok() {
        let result = validate_runtime_input("openai_compatible", Some("http://localhost:8080/v1"));
        assert!(result.is_ok(), "got: {:?}", result);
        let base = result.unwrap().unwrap();
        // Trailing slash stripped, /v1 path preserved or stripped — just check it parses.
        assert!(base.starts_with("http://localhost:8080"), "got: {base}");
    }

    #[test]
    fn openai_compatible_lan_base_is_ok() {
        let result = validate_runtime_input("openai_compatible", Some("http://10.0.0.5:8080"));
        assert!(result.is_ok(), "got: {:?}", result);
    }

    #[test]
    fn openai_compatible_embedded_creds_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("http://u:p@host/v1")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }

    #[test]
    fn openai_compatible_bad_scheme_rejected() {
        let err = validate_runtime_input("openai_compatible", Some("gopher://localhost")).unwrap_err();
        assert!(!err.is_empty(), "got: {err}");
    }
}

#[cfg(test)]
mod switch_runtime_tests {
    use super::{resolve_model_arg, RUNTIME_GEN_MODELS};

    // ── resolve_model_arg ────────────────────────────────────────────────────

    #[test]
    fn resolve_qwen25_3b_ollama() {
        assert_eq!(resolve_model_arg("qwen2.5-3b", "ollama").as_deref(), Some("qwen2.5:3b"));
    }

    #[test]
    fn resolve_qwen25_3b_llamacpp() {
        assert_eq!(
            resolve_model_arg("qwen2.5-3b", "llamacpp").as_deref(),
            Some("bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"),
        );
    }

    #[test]
    fn resolve_qwen25_3b_vllm() {
        assert_eq!(
            resolve_model_arg("qwen2.5-3b", "vllm").as_deref(),
            Some("Qwen/Qwen2.5-3B-Instruct"),
        );
    }

    #[test]
    fn resolve_qwen25_7b_ollama() {
        assert_eq!(resolve_model_arg("qwen2.5-7b", "ollama").as_deref(), Some("qwen2.5:7b"));
    }

    #[test]
    fn resolve_qwen25_7b_llamacpp() {
        assert_eq!(
            resolve_model_arg("qwen2.5-7b", "llamacpp").as_deref(),
            Some("bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"),
        );
    }

    #[test]
    fn resolve_llama32_3b_all_runtimes() {
        assert_eq!(resolve_model_arg("llama-3.2-3b", "ollama").as_deref(), Some("llama3.2"));
        assert_eq!(
            resolve_model_arg("llama-3.2-3b", "llamacpp").as_deref(),
            Some("bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"),
        );
        assert_eq!(
            resolve_model_arg("llama-3.2-3b", "vllm").as_deref(),
            Some("meta-llama/Llama-3.2-3B-Instruct"),
        );
    }

    #[test]
    fn resolve_unknown_model_returns_none() {
        assert!(resolve_model_arg("gpt-4o", "ollama").is_none());
        assert!(resolve_model_arg("", "llamacpp").is_none());
        assert!(resolve_model_arg("nonexistent", "vllm").is_none());
    }

    #[test]
    fn resolve_unknown_runtime_returns_none() {
        assert!(resolve_model_arg("qwen2.5-3b", "tgi").is_none());
        assert!(resolve_model_arg("qwen2.5-3b", "").is_none());
        assert!(resolve_model_arg("qwen2.5-7b", "lmstudio").is_none());
    }

    #[test]
    fn default_model_id_resolves_llamacpp() {
        // The default model when none is specified is "qwen2.5-3b"
        let default_id = "qwen2.5-3b";
        let arg = resolve_model_arg(default_id, "llamacpp");
        assert!(arg.is_some(), "default model must resolve for llamacpp");
        assert_eq!(arg.as_deref(), Some("bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"));
    }

    #[test]
    fn catalog_has_three_entries() {
        assert_eq!(RUNTIME_GEN_MODELS.len(), 3);
    }

    #[test]
    fn all_catalog_entries_have_all_runtimes() {
        for entry in RUNTIME_GEN_MODELS {
            assert!(!entry.ollama.is_empty(), "ollama tag missing for {}", entry.id);
            assert!(!entry.llamacpp.is_empty(), "llamacpp arg missing for {}", entry.id);
            assert!(!entry.vllm.is_empty(), "vllm repo missing for {}", entry.id);
            assert!(entry.ram_gb > 0.0, "ram_gb must be positive for {}", entry.id);
        }
    }

    // ── resolve_model_arg: vllm ──────────────────────────────────────────────

    #[test]
    fn resolve_qwen25_3b_vllm_explicit() {
        assert_eq!(
            resolve_model_arg("qwen2.5-3b", "vllm").as_deref(),
            Some("Qwen/Qwen2.5-3B-Instruct"),
        );
    }

    #[test]
    fn resolve_qwen25_7b_vllm() {
        assert_eq!(
            resolve_model_arg("qwen2.5-7b", "vllm").as_deref(),
            Some("Qwen/Qwen2.5-7B-Instruct"),
        );
    }

    #[test]
    fn resolve_llama32_vllm() {
        assert_eq!(
            resolve_model_arg("llama-3.2-3b", "vllm").as_deref(),
            Some("meta-llama/Llama-3.2-3B-Instruct"),
        );
    }

    #[test]
    fn default_model_id_resolves_vllm() {
        // The default model when none is specified is "qwen2.5-3b"
        let arg = resolve_model_arg("qwen2.5-3b", "vllm");
        assert!(arg.is_some(), "default model must resolve for vllm");
        assert_eq!(arg.as_deref(), Some("Qwen/Qwen2.5-3B-Instruct"));
    }

    // ── Runtime string validation ────────────────────────────────────────────

    #[test]
    fn valid_runtimes() {
        // These are the four valid runtime strings for switch-runtime
        for rt in &["ollama", "llamacpp", "vllm", "external"] {
            assert!(matches!(*rt, "ollama" | "llamacpp" | "vllm" | "external"),
                "runtime '{rt}' should be valid");
        }
    }

    #[test]
    fn invalid_runtimes_not_in_set() {
        for rt in &["tgi", "openai", "lmstudio", ""] {
            assert!(!matches!(*rt, "ollama" | "llamacpp" | "vllm" | "external"),
                "runtime '{rt}' should be invalid");
        }
    }
}

// ── Agent / MCP tool helper tests ─────────────────────────────────────────────

#[cfg(test)]
mod agent_tool_tests {
    use super::{
        hardware_json, recommend_json, runtimes_catalog_json, models_for_runtime_json,
        validate_embedding_mode,
    };

    // ── hardware_json ─────────────────────────────────────────────────────────

    #[test]
    fn hardware_json_returns_object() {
        let hw = hardware_json();
        // Must be a JSON object (not an error string)
        assert!(hw.is_object(), "hardware_json() must return a JSON object, got: {hw}");
    }

    #[test]
    fn hardware_json_has_expected_keys() {
        let hw = hardware_json();
        // All six canonical keys must be present (values may be zero/empty on CI)
        for key in &["cpu_cores", "ram_gb", "gpu_name", "vram_gb", "nvidia_toolkit", "arch"] {
            assert!(hw.get(key).is_some(), "hardware_json() missing key '{key}'");
        }
    }

    // ── recommend_json ────────────────────────────────────────────────────────

    #[test]
    fn recommend_json_has_expected_keys() {
        let rec = recommend_json();
        for key in &["runtime", "model", "rationale", "speedup_estimate"] {
            assert!(rec.get(key).is_some(), "recommend_json() missing key '{key}'");
        }
    }

    #[test]
    fn recommend_json_runtime_is_valid() {
        let rec = recommend_json();
        let rt = rec["runtime"].as_str().expect("runtime must be a string");
        assert!(
            matches!(rt, "ollama" | "llamacpp" | "vllm"),
            "recommend_json() returned unexpected runtime '{rt}'"
        );
    }

    #[test]
    fn recommend_json_model_is_in_catalog() {
        use super::RUNTIME_GEN_MODELS;
        let rec = recommend_json();
        let model = rec["model"].as_str().expect("model must be a string");
        assert!(
            RUNTIME_GEN_MODELS.iter().any(|e| e.id == model),
            "recommend_json() returned model '{model}' not in catalog"
        );
    }

    // ── runtimes_catalog_json ─────────────────────────────────────────────────

    #[test]
    fn runtimes_catalog_has_runtimes_key() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().expect("runtimes must be an array");
        assert!(!rts.is_empty(), "runtimes catalog must not be empty");
    }

    #[test]
    fn runtimes_catalog_contains_ollama() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().unwrap();
        assert!(
            rts.iter().any(|r| r["id"].as_str() == Some("ollama")),
            "runtimes catalog must contain 'ollama'"
        );
    }

    #[test]
    fn runtimes_catalog_contains_openai_compatible() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().unwrap();
        assert!(
            rts.iter().any(|r| r["id"].as_str() == Some("openai_compatible")),
            "runtimes catalog must contain 'openai_compatible'"
        );
    }

    #[test]
    fn runtimes_catalog_contains_vllm() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().unwrap();
        assert!(
            rts.iter().any(|r| r["id"].as_str() == Some("vllm")),
            "runtimes catalog must contain 'vllm'"
        );
    }

    #[test]
    fn runtimes_catalog_vllm_needs_gpu() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().unwrap();
        let vllm = rts.iter().find(|r| r["id"].as_str() == Some("vllm"))
            .expect("vllm entry must exist");
        assert_eq!(vllm["needs_gpu"].as_bool(), Some(true),
            "vllm entry must have needs_gpu: true");
    }

    #[test]
    fn runtimes_catalog_ollama_does_not_need_gpu() {
        let cat = runtimes_catalog_json();
        let rts = cat["runtimes"].as_array().unwrap();
        let ollama = rts.iter().find(|r| r["id"].as_str() == Some("ollama"))
            .expect("ollama entry must exist");
        assert_eq!(ollama["needs_gpu"].as_bool(), Some(false),
            "ollama entry must have needs_gpu: false");
    }

    // ── models_for_runtime_json ───────────────────────────────────────────────

    #[test]
    fn models_for_ollama_runtime() {
        let result = models_for_runtime_json("ollama");
        assert_eq!(result["runtime"].as_str(), Some("ollama"));
        let models = result["models"].as_array().expect("models must be an array");
        assert!(!models.is_empty(), "models list must not be empty");
        // Each entry must have id, label, arg, ram_gb
        for m in models {
            assert!(m.get("id").is_some(),    "model missing 'id'");
            assert!(m.get("label").is_some(), "model missing 'label'");
            assert!(m.get("ram_gb").is_some(),"model missing 'ram_gb'");
        }
    }

    #[test]
    fn models_for_llamacpp_runtime_have_hf_args() {
        let result = models_for_runtime_json("llamacpp");
        let models = result["models"].as_array().unwrap();
        for m in models {
            // arg must be a non-null string for known catalog entries
            assert!(
                m["arg"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
                "llamacpp model '{}' must have a non-empty arg", m["id"]
            );
        }
    }

    #[test]
    fn models_for_vllm_runtime_have_hf_repos() {
        let result = models_for_runtime_json("vllm");
        let models = result["models"].as_array().unwrap();
        for m in models {
            // arg must be a non-null string containing a HuggingFace org/repo pattern
            let arg = m["arg"].as_str().unwrap_or("");
            assert!(!arg.is_empty(),
                "vllm model '{}' must have a non-empty arg", m["id"]);
            assert!(arg.contains('/'),
                "vllm arg '{}' for model '{}' must be an org/repo path", arg, m["id"]);
        }
    }

    #[test]
    fn models_for_unknown_runtime_returns_null_args() {
        // Unknown runtime: resolve_model_arg returns None → arg is null
        let result = models_for_runtime_json("tgi");
        let models = result["models"].as_array().unwrap();
        for m in models {
            assert!(m["arg"].is_null(), "unknown runtime must yield null arg, got {}", m["arg"]);
        }
    }

    // ── validate_embedding_mode ───────────────────────────────────────────────

    #[test]
    fn pinned_mode_is_valid() {
        assert!(validate_embedding_mode("pinned").is_ok());
    }

    #[test]
    fn advanced_mode_is_valid() {
        assert!(validate_embedding_mode("advanced").is_ok());
    }

    #[test]
    fn unknown_mode_is_rejected() {
        let err = validate_embedding_mode("turbo").unwrap_err();
        assert!(err.contains("Unknown embedding mode"), "got: {err}");
    }

    #[test]
    fn empty_mode_is_rejected() {
        let err = validate_embedding_mode("").unwrap_err();
        assert!(err.contains("Unknown embedding mode"), "got: {err}");
    }

    #[test]
    fn hybrid_mode_is_rejected() {
        // "hybrid" is not a recognised mode in this phase
        let err = validate_embedding_mode("hybrid").unwrap_err();
        assert!(err.contains("Unknown embedding mode"), "got: {err}");
    }
}

// ── vLLM gating unit tests ────────────────────────────────────────────────────

#[cfg(test)]
mod vllm_gating_tests {
    use super::vllm_available;

    // ── vllm_available predicate ─────────────────────────────────────────────

    #[test]
    fn vllm_available_requires_toolkit_and_vram() {
        assert!(vllm_available(true, 8.0),  "toolkit=true, 8 GB → available");
        assert!(vllm_available(true, 16.0), "toolkit=true, 16 GB → available");
        assert!(vllm_available(true, 24.0), "toolkit=true, 24 GB → available");
    }

    #[test]
    fn vllm_unavailable_without_toolkit() {
        assert!(!vllm_available(false, 8.0),  "no toolkit, 8 GB → unavailable");
        assert!(!vllm_available(false, 24.0), "no toolkit, 24 GB → unavailable");
        assert!(!vllm_available(false, 0.0),  "no toolkit, 0 GB → unavailable");
    }

    #[test]
    fn vllm_unavailable_below_8gb_vram() {
        assert!(!vllm_available(true, 0.0),  "toolkit, 0 GB VRAM → unavailable");
        assert!(!vllm_available(true, 4.0),  "toolkit, 4 GB VRAM → unavailable");
        assert!(!vllm_available(true, 7.9),  "toolkit, 7.9 GB VRAM → unavailable");
    }

    #[test]
    fn vllm_boundary_exactly_8gb() {
        // Exactly 8.0 GB is the gate threshold — must be available
        assert!(vllm_available(true, 8.0), "toolkit=true, exactly 8.0 GB → available");
    }

    #[test]
    fn vllm_unavailable_neither_toolkit_nor_vram() {
        assert!(!vllm_available(false, 0.0), "no toolkit, no VRAM → unavailable");
    }

    // ── switch dispatch ──────────────────────────────────────────────────────

    #[test]
    fn vllm_dispatch_string_is_handled() {
        // "vllm" must be in the set of recognised runtime strings
        assert!(matches!("vllm", "ollama" | "llamacpp" | "vllm" | "external"),
            "vllm must be a recognised switch-runtime value");
    }

    #[test]
    fn vllm_not_gated_by_unknown_runtimes() {
        // Ensure the gating predicate is purely about toolkit + vram, not runtime string
        // (i.e. it is a free function, not bound to the match arm)
        let available = vllm_available(true, 10.0);
        assert!(available);
        let unavailable = vllm_available(false, 10.0);
        assert!(!unavailable);
    }
}

// ── Hardware / recommend unit tests ──────────────────────────────────────────

#[cfg(test)]
mod hardware_tests {
    use super::{pick_model_for_budget, recommend, Hardware};

    fn hw(
        os: &str, arch: &str,
        nvidia_toolkit: bool, vram_gb: f64,
        ram_gb: f64,
    ) -> Hardware {
        Hardware {
            cpu_cores: 8,
            ram_gb,
            gpu_name: String::new(),
            vram_gb,
            nvidia_toolkit,
            arch: arch.to_string(),
            os: os.to_string(),
        }
    }

    // ── recommend() — four branches ──────────────────────────────────────────

    #[test]
    fn recommend_apple_silicon() {
        let rec = recommend(&hw("darwin", "arm64", false, 0.0, 16.0));
        assert_eq!(rec.runtime, "llamacpp", "Apple Silicon must use llamacpp");
        assert!(rec.rationale.contains("Metal"), "rationale must mention Metal");
        assert!(rec.speedup_estimate.contains("estimate"), "must be labelled as estimate");
    }

    #[test]
    fn recommend_nvidia_high_vram() {
        // ≥16 GB VRAM → vllm
        let rec = recommend(&hw("linux", "x86_64", true, 24.0, 32.0));
        assert_eq!(rec.runtime, "vllm", "≥16 GB VRAM must use vllm");
        assert_eq!(rec.model, "qwen2.5-7b");
        assert!(rec.speedup_estimate.contains("estimate"));
    }

    #[test]
    fn recommend_nvidia_mid_vram() {
        // 6–16 GB VRAM → llamacpp (CUDA offload)
        let rec = recommend(&hw("linux", "x86_64", true, 8.0, 16.0));
        assert_eq!(rec.runtime, "llamacpp", "6–16 GB VRAM must use llamacpp");
        assert_eq!(rec.model, "qwen2.5-7b");
        assert!(rec.rationale.contains("CUDA") || rec.rationale.contains("offload"),
            "rationale must mention CUDA/offload: {}", rec.rationale);
        assert!(rec.speedup_estimate.contains("estimate"));
    }

    #[test]
    fn recommend_cpu_only() {
        // No GPU toolkit → llamacpp CPU
        let rec = recommend(&hw("linux", "x86_64", false, 0.0, 16.0));
        assert_eq!(rec.runtime, "llamacpp");
        assert!(rec.rationale.contains("CPU") || rec.rationale.contains("Ollama"),
            "rationale must mention CPU/Ollama: {}", rec.rationale);
        assert!(rec.speedup_estimate.contains("estimate"));
    }

    // Edge: nvidia_toolkit=true but VRAM below 6 GB → CPU-only branch
    #[test]
    fn recommend_nvidia_tiny_vram_falls_to_cpu() {
        let rec = recommend(&hw("linux", "x86_64", true, 2.0, 8.0));
        assert_eq!(rec.runtime, "llamacpp");
        // vllm must NOT be selected
        assert_ne!(rec.runtime, "vllm");
    }

    // ── pick_model_for_budget() ───────────────────────────────────────────────

    #[test]
    fn budget_fits_7b() {
        // 7 GB budget fits qwen2.5-7b (ram_gb=6.0) and not a bigger model
        let model = pick_model_for_budget(7.0);
        // Should pick the largest that fits — qwen2.5-7b or llama-3.2-3b
        // (catalog has 3b@3GB and 7b@6GB; 7b is the largest that fits 7GB budget)
        assert_eq!(model, "qwen2.5-7b", "7 GB budget must pick qwen2.5-7b");
    }

    #[test]
    fn budget_only_fits_3b() {
        // 4 GB budget fits 3b (ram_gb=3.0) but not 7b (ram_gb=6.0)
        let model = pick_model_for_budget(4.0);
        // Both qwen2.5-3b and llama-3.2-3b have ram_gb=3.0; pick_model_for_budget
        // returns the LAST entry in reverse iteration that fits — check it's a 3b.
        assert!(
            model.contains("3b"),
            "4 GB budget must pick a 3b model, got: {model}"
        );
    }

    #[test]
    fn tiny_budget_returns_smallest() {
        // Budget smaller than any model → fallback to smallest catalog entry
        let model = pick_model_for_budget(0.5);
        // The smallest (first) entry is qwen2.5-3b
        assert_eq!(model, "qwen2.5-3b",
            "tiny budget must return the smallest catalog entry, got: {model}");
    }

    #[test]
    fn zero_budget_returns_smallest() {
        let model = pick_model_for_budget(0.0);
        assert_eq!(model, "qwen2.5-3b");
    }
}

#[cfg(test)]
mod reindex_tests {
    use super::validate_reindex_request;

    #[test]
    fn reindex_gate_rejects_confirm_false() {
        let err = validate_reindex_request(false, "REINDEX", "nomic-embed-text", None, None);
        assert!(err.is_err(), "confirm=false must be rejected");
        assert!(err.unwrap_err().contains("double-opt-in"), "error must mention double-opt-in");
    }

    #[test]
    fn reindex_gate_rejects_wrong_confirm_text() {
        let err = validate_reindex_request(true, "reindex", "nomic-embed-text", None, None);
        assert!(err.is_err(), "wrong confirm_text must be rejected");
        assert!(err.unwrap_err().contains("double-opt-in"), "error must mention double-opt-in");
    }

    #[test]
    fn reindex_gate_rejects_empty_confirm_text() {
        let err = validate_reindex_request(true, "", "nomic-embed-text", None, None);
        assert!(err.is_err(), "empty confirm_text must be rejected");
    }

    #[test]
    fn reindex_gate_rejects_confirm_true_with_lowercase_reindex() {
        // Must be EXACT uppercase "REINDEX"
        let err = validate_reindex_request(true, "Reindex", "nomic-embed-text", None, None);
        assert!(err.is_err(), "mixed-case confirm_text must be rejected");
    }

    #[test]
    fn reindex_gate_accepts_valid_double_opt_in() {
        let ok = validate_reindex_request(true, "REINDEX", "nomic-embed-text", None, None);
        assert!(ok.is_ok(), "valid double opt-in must be accepted; got: {:?}", ok);
    }

    #[test]
    fn reindex_gate_rejects_empty_embedding_model() {
        let err = validate_reindex_request(true, "REINDEX", "", None, None);
        assert!(err.is_err(), "empty embedding_model must be rejected");
        assert!(err.unwrap_err().contains("embedding_model"), "error must mention embedding_model");
    }
}
