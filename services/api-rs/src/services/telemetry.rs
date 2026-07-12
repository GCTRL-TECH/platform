//! Optional OTLP export of tracing spans to a SELF-HOSTED Arize Phoenix.
//!
//! OFF by default — spans are only exported when `PHOENIX_OTLP_URL` is set
//! (e.g. `http://host.docker.internal:6006/v1/traces`). When unset, tracing
//! stays exactly as before (plain `fmt` to stdout). A broken exporter degrades
//! to fmt-only and logs the error — telemetry must never take the API down.
//!
//! Spans use OpenInference attributes (`openinference.span.kind`, `input.value`,
//! `gctrl.is_error`) so Phoenix renders them as TOOL/CHAIN nodes, matching the
//! Anvil- and Python-side spans in the same `gctrl` project. Traces contain
//! prompts + knowledge content → self-hosted Phoenix only, never a cloud
//! collector (same stance as the rest of the stack).

use std::sync::OnceLock;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{runtime, trace::TracerProvider, Resource};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

// Keep the provider alive for the process lifetime; dropping it stops the
// batch exporter background task and silently loses spans.
static PROVIDER: OnceLock<TracerProvider> = OnceLock::new();

/// Initialise tracing. Wires the OTLP→Phoenix layer only when PHOENIX_OTLP_URL
/// is set; otherwise (and on any exporter build error) falls back to the plain
/// fmt subscriber the service always had. Call ONCE at startup.
pub fn init() {
    let url = std::env::var("PHOENIX_OTLP_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let Some(url) = url else {
        // Off — unchanged behaviour.
        tracing_subscriber::registry()
            .with(EnvFilter::from_default_env())
            .with(tracing_subscriber::fmt::layer())
            .init();
        return;
    };

    match build_provider(&url) {
        Ok(provider) => {
            let tracer = provider.tracer("gctrl-api");
            let _ = PROVIDER.set(provider);
            tracing_subscriber::registry()
                .with(EnvFilter::from_default_env())
                .with(tracing_subscriber::fmt::layer())
                .with(tracing_opentelemetry::layer().with_tracer(tracer))
                .init();
            tracing::info!("Phoenix tracing enabled → {url}");
        }
        Err(e) => {
            tracing_subscriber::registry()
                .with(EnvFilter::from_default_env())
                .with(tracing_subscriber::fmt::layer())
                .init();
            tracing::error!("Phoenix tracing init failed ({e}) — continuing without export");
        }
    }
}

fn build_provider(url: &str) -> Result<TracerProvider, Box<dyn std::error::Error>> {
    // opentelemetry-otlp 0.27 HTTP uses `with_endpoint` VERBATIM — it does NOT
    // append `/v1/traces` (verified live: a base URL POSTed to `/` → 405). So
    // hand it the FULL traces URL. Our PHOENIX_OTLP_URL already ends in
    // `/v1/traces` (shared with the Python services); ensure it does.
    let mut endpoint = url.trim_end_matches('/').to_string();
    if !endpoint.ends_with("/v1/traces") {
        endpoint.push_str("/v1/traces");
    }

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_protocol(Protocol::HttpBinary)
        .build()?;

    let project = std::env::var("PHOENIX_PROJECT_NAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gctrl".to_string());

    let provider = TracerProvider::builder()
        .with_batch_exporter(exporter, runtime::Tokio)
        .with_resource(Resource::new(vec![
            KeyValue::new("service.name", "gctrl-api"),
            KeyValue::new("openinference.project.name", project),
        ]))
        .build();
    Ok(provider)
}

/// Cap a span attribute payload (prompts / args / knowledge) so spans stay light.
pub fn trunc(s: &str) -> String {
    const MAX: usize = 2000;
    if s.len() > MAX {
        let mut cut = MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    } else {
        s.to_string()
    }
}
