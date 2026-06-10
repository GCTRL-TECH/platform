//! Local token-usage recorder.
//!
//! Every spend in the api-rs (KEX extract/upload, FUSE merge, RAG query, etc.)
//! must drop a row into `token_usage` so the background heartbeat task can ship
//! the deltas to the central license-api on the VPS. The local
//! `users.tokens_balance` deduction stays — this helper sits beside it.

use sqlx::PgPool;
use uuid::Uuid;

/// Record one token-deduction event in `token_usage`.
///
/// Best-effort: a failure to insert is logged but **does not** propagate, so a
/// transient DB hiccup never wedges a real user-facing operation (the spend has
/// already been applied to `users.tokens_balance`). The license-api eventually
/// reconciles from `users.creditsBalance` truth on the next successful heartbeat.
pub async fn record_usage(
    db: &PgPool,
    user_id: Uuid,
    action: &str,
    tokens_spent: i32,
    job_id: Option<Uuid>,
) {
    let res = sqlx::query(
        "INSERT INTO token_usage (user_id, action, tokens_spent, job_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(action)
    .bind(tokens_spent)
    .bind(job_id)
    .execute(db)
    .await;

    if let Err(e) = res {
        tracing::warn!(
            "record_usage failed (user={user_id}, action={action}, n={tokens_spent}): {e}"
        );
    }
}
