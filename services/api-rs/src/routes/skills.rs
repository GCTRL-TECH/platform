//! Agent skills (`/api/skills`).
//!
//! Turns the old dead "Skills" toggle into a real system. A skill is a labelled
//! block of guidance (and/or a tool set) folded into the Pi agent's system prompt
//! at request time. Three kinds:
//!   * builtin  — the hard-wired GCTRL knowledge tools. `locked`, always on.
//!   * curated  — prompt-packs we ship (RAG Expert, DB Engineer). On by default,
//!                each user may opt out per-user via `agent_skill_prefs`.
//!   * github   — a skill a user added from a public GitHub repo (SKILL.md /
//!                manifest.json). User-scoped (`user_id` = owner).
//!
//! ## Routes (mounted under `/api/skills`)
//! - `GET    /skills`              → the caller's effective skill list (+ enabled)
//! - `POST   /skills/:slug/toggle` → enable/disable a system curated skill
//! - `POST   /skills`              → add a github skill from `{ repoUrl }`
//! - `DELETE /skills/:id`          → remove one of the caller's github skills
//!
//! The harness reads the same effective set via [`load_effective_skills`].

use axum::{
    extract::{Extension, Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
};

/// Max bytes we accept from a fetched GitHub skill manifest.
const MAX_MANIFEST_BYTES: usize = 512 * 1024;

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        .route("/", get(list_skills).post(add_github_skill))
        .route("/:slug/toggle", post(toggle_skill))
        .route("/id/:id", axum::routing::delete(delete_skill))
}

// ── Shared model: an effective skill for one user ────────────────────────────

/// A skill as it applies to a given user, with `enabled` already resolved
/// (system curated honour `agent_skill_prefs`; locked builtins are always on).
#[derive(Debug, Clone)]
pub struct EffectiveSkill {
    pub id: uuid::Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: String,
    pub repo_url: Option<String>,
    pub manifest: Option<Value>,
    pub locked: bool,
    pub enabled: bool,
    pub system: bool,
}

impl EffectiveSkill {
    /// The prompt-pack guidance text for this skill, if any (`manifest.prompt`).
    pub fn prompt(&self) -> Option<String> {
        self.manifest
            .as_ref()
            .and_then(|m| m.get("prompt"))
            .and_then(|p| p.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

/// Load the caller's effective skills: the system rows (`user_id IS NULL`) with
/// per-user enable overrides applied, plus the caller's own github rows.
/// Builtins (`locked`) are always enabled regardless of any pref.
pub async fn load_effective_skills(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> Vec<EffectiveSkill> {
    // System rows + this user's github rows in one pass, with the user's pref
    // for each system slug LEFT-joined in.
    let rows = sqlx::query_as::<
        _,
        (
            uuid::Uuid,
            Option<uuid::Uuid>,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<Value>,
            bool,
            bool,
            Option<bool>,
        ),
    >(
        "SELECT s.id, s.user_id, s.slug, s.name, s.description, s.kind, s.repo_url,
                s.manifest, s.locked, s.enabled, p.enabled AS pref_enabled
         FROM agent_skills s
         LEFT JOIN agent_skill_prefs p
                ON p.user_id = $1 AND p.slug = s.slug AND s.user_id IS NULL
         WHERE s.user_id IS NULL OR s.user_id = $1
         ORDER BY (s.user_id IS NOT NULL), s.kind, s.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(
            |(id, uid, slug, name, description, kind, repo_url, manifest, locked, enabled, pref)| {
                let system = uid.is_none();
                // Locked → always on. System → pref overrides default `enabled`.
                // User github rows → their own `enabled` column.
                let effective_enabled = if locked {
                    true
                } else if system {
                    pref.unwrap_or(enabled)
                } else {
                    enabled
                };
                EffectiveSkill {
                    id,
                    slug,
                    name,
                    description,
                    kind,
                    repo_url,
                    manifest,
                    locked,
                    enabled: effective_enabled,
                    system,
                }
            },
        )
        .collect()
}

// ── GET /skills ──────────────────────────────────────────────────────────────

async fn list_skills(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Json<Value> {
    let skills = load_effective_skills(&state.db, claims.sub).await;
    let out: Vec<Value> = skills
        .iter()
        .map(|s| {
            json!({
                "id":          s.id,
                "slug":        s.slug,
                "name":        s.name,
                "description": s.description,
                "kind":        s.kind,
                "repoUrl":     s.repo_url,
                "locked":      s.locked,
                "enabled":     s.enabled,
                "system":      s.system,
            })
        })
        .collect();
    Json(json!({ "skills": out }))
}

// ── POST /skills/:slug/toggle ────────────────────────────────────────────────

#[derive(Deserialize)]
struct ToggleReq {
    enabled: bool,
}

/// Enable/disable a system curated skill for the caller (upsert into
/// `agent_skill_prefs`). Toggling a locked skill is rejected with 400.
async fn toggle_skill(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(slug): Path<String>,
    Json(req): Json<ToggleReq>,
) -> Result<Json<Value>> {
    let slug = slug.trim().to_string();

    // Only system skills are toggled via prefs; locked ones can never be toggled.
    let row: Option<(bool,)> = sqlx::query_as(
        "SELECT locked FROM agent_skills WHERE user_id IS NULL AND slug = $1",
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await?;

    let locked = match row {
        Some((locked,)) => locked,
        None => return Err(AppError::NotFound),
    };
    if locked {
        return Err(AppError::BadRequest(
            "This skill is built-in and always on; it cannot be disabled.".into(),
        ));
    }

    sqlx::query(
        "INSERT INTO agent_skill_prefs (user_id, slug, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, slug) DO UPDATE SET enabled = $3",
    )
    .bind(claims.sub)
    .bind(&slug)
    .bind(req.enabled)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true, "slug": slug, "enabled": req.enabled })))
}

// ── POST /skills (add a github skill) ────────────────────────────────────────

#[derive(Deserialize)]
struct AddReq {
    #[serde(rename = "repoUrl")]
    repo_url: String,
}

/// Add a skill from a public GitHub repo. We parse `owner/repo` from the URL,
/// fetch `SKILL.md` (then `manifest.json`) from the repo root over the raw host,
/// trying `main` then `master`, and store an `agent_skills` row (kind `github`).
///
/// SSRF: only `github.com` / `raw.githubusercontent.com` are ever contacted; the
/// owner/repo path is sanitised; the fetched body is size-capped.
async fn add_github_skill(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<AddReq>,
) -> Result<Json<Value>> {
    let (owner, repo) = parse_github_repo(&req.repo_url)
        .ok_or_else(|| AppError::BadRequest("Provide a valid https://github.com/<owner>/<repo> URL".into()))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // Be lenient: a public skill repo can keep its guidance in many places. We try
    // a broad set of well-known locations, and as a LAST resort fold the README so
    // almost any public repo ingests. `text` = markdown body, `json` = manifest.
    let branches = ["main", "master"];

    // If the pasted URL points at a subdirectory (…/tree|blob/<branch>/<path>),
    // prefer that exact skill folder first.
    let subpath = parse_github_subpath(&req.repo_url);
    let mut candidates: Vec<(String, &str)> = Vec::new();
    if let Some(ref p) = subpath {
        for (f, fmt) in [
            ("SKILL.md", "text"), ("skill.md", "text"), ("manifest.json", "json"),
            ("skill.json", "json"), ("plugin.json", "json"), ("README.md", "text"),
        ] {
            candidates.push((format!("{p}/{f}"), fmt));
        }
    }
    // Skill-specific guidance first, then manifests, then README as a fallback.
    for (f, fmt) in [
        ("SKILL.md", "text"),
        ("skill.md", "text"),
        ("skills/SKILL.md", "text"),
        (".claude/skills/SKILL.md", "text"),
        ("manifest.json", "json"),
        ("skill.json", "json"),
        (".claude-plugin/plugin.json", "json"),
        ("README.md", "text"),
        ("readme.md", "text"),
    ] {
        candidates.push((f.to_string(), fmt));
    }

    let mut fetched: Option<(String, String, String)> = None; // (file, fmt, body)
    'outer: for (file, fmt) in &candidates {
        for branch in branches {
            let url = format!(
                "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{file}"
            );
            // Defence in depth: the URL we built must point at the raw host + no traversal.
            if !is_allowed_github_url(&url) {
                continue;
            }
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    if body.trim().is_empty() {
                        continue;
                    }
                    let body = if body.len() > MAX_MANIFEST_BYTES {
                        body.chars().take(MAX_MANIFEST_BYTES).collect()
                    } else {
                        body
                    };
                    fetched = Some((file.clone(), fmt.to_string(), body));
                    break 'outer;
                }
            }
        }
    }

    let (file, fmt, body) = fetched.ok_or_else(|| {
        AppError::BadRequest(format!(
            "No skill guidance found in {owner}/{repo} — looked for SKILL.md, \
             manifest.json/skill.json, .claude-plugin/plugin.json, and README.md on main/master."
        ))
    })?;

    // Build the stored manifest. For markdown we wrap the text as the prompt; for
    // JSON we keep the parsed object but also normalise a `prompt` field so the
    // harness has guidance text to fold in (fall back to the raw JSON text).
    let (name, manifest): (String, Value) = if fmt == "json" {
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| AppError::BadRequest("manifest.json is not valid JSON".into()))?;
        let name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| repo.clone());
        let prompt = parsed
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                parsed
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| body.clone());
        // Preserve the source object alongside a normalised prompt.
        let mut m = parsed;
        if let Value::Object(ref mut map) = m {
            map.insert("prompt".into(), json!(prompt));
            map.insert("source".into(), json!(format!("{owner}/{repo}/{file}")));
        }
        (name, m)
    } else {
        // Markdown: title from the first ATX heading, else the repo name.
        let name = body
            .lines()
            .find_map(|l| l.trim().strip_prefix("# ").map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| repo.clone());
        (
            name,
            json!({ "prompt": body, "source": format!("{owner}/{repo}/{file}") }),
        )
    };

    let slug = slugify(&format!("gh-{owner}-{repo}"));
    let repo_url = format!("https://github.com/{owner}/{repo}");

    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO agent_skills (user_id, slug, name, description, kind, repo_url, manifest, locked, enabled)
         VALUES ($1, $2, $3, $4, 'github', $5, $6, false, true)
         ON CONFLICT (user_id, slug) WHERE user_id IS NOT NULL DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description,
            repo_url = EXCLUDED.repo_url, manifest = EXCLUDED.manifest, enabled = true
         RETURNING id",
    )
    .bind(claims.sub)
    .bind(&slug)
    .bind(&name)
    .bind(format!("GitHub skill from {owner}/{repo}"))
    .bind(&repo_url)
    .bind(&manifest)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "ok": true,
        "id": id,
        "slug": slug,
        "name": name,
        "repoUrl": repo_url,
        "source": file,
    })))
}

// ── DELETE /skills/id/:id ─────────────────────────────────────────────────────

/// Remove one of the caller's github skills. System rows (user_id NULL) are never
/// matched, so a user can never delete a system skill.
async fn delete_skill(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Json<Value>> {
    let res = sqlx::query(
        "DELETE FROM agent_skills WHERE id = $1 AND user_id = $2 AND kind = 'github'",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true, "deleted": res.rows_affected() })))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Parse `owner` and `repo` from a GitHub repo URL. Only `github.com` is accepted.
/// Strips a trailing `.git` and ignores any deeper path (tree/blob/…).
fn parse_github_repo(raw: &str) -> Option<(String, String)> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let mut segs = url.path_segments()?.filter(|s| !s.is_empty());
    let owner = segs.next()?.to_string();
    let repo = segs.next()?.trim_end_matches(".git").to_string();
    if !is_safe_path_segment(&owner) || !is_safe_path_segment(&repo) {
        return None;
    }
    Some((owner, repo))
}

/// Extract a subdirectory from a GitHub `…/tree/<branch>/<path>` or
/// `…/blob/<branch>/<path>` URL so a user can point at a specific skill folder.
/// Returns the `<path>` (slash-joined) when every segment is safe, else None.
fn parse_github_subpath(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let segs: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    // [owner, repo, ("tree"|"blob"), branch, ...path]
    if segs.len() < 5 || !(segs[2] == "tree" || segs[2] == "blob") {
        return None;
    }
    let parts = &segs[4..];
    if parts.iter().all(|s| is_safe_path_segment(s)) && !parts.is_empty() {
        Some(parts.join("/"))
    } else {
        None
    }
}

/// Only the raw GitHub host over https, and a path with no traversal.
fn is_allowed_github_url(raw: &str) -> bool {
    match url::Url::parse(raw) {
        Ok(u) => {
            u.scheme() == "https"
                && u
                    .host_str()
                    .map(|h| h.eq_ignore_ascii_case("raw.githubusercontent.com"))
                    .unwrap_or(false)
                && !u.path().contains("..")
        }
        Err(_) => false,
    }
}

/// Allow only conservative GitHub owner/repo characters (no slashes, dots-only,
/// or traversal); GitHub itself permits alnum, `-`, `_`, and `.` in repo names.
fn is_safe_path_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Lowercase, hyphenate, strip to a safe slug.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}
