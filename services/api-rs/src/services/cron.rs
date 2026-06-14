//! Minimal cron "next run" computation.
//!
//! The frontend emits standard 5-field cron strings, but only a handful of
//! shapes in practice (`* * * * *`, `*/N * * * *`, `0 */N * * *`, `M * * * *`,
//! `M H * * *`). Rather than pull a full cron crate whose 6/7-field syntax does
//! not match the 5-field strings the UI produces, we re-implement the same small
//! decision tree the legacy TS heartbeat used (`services/heartbeat.ts`), so
//! manual and scheduled runs compute identical `next_run_at` values.
//!
//! Anything we don't recognise falls back to "24h from now" — safe and never
//! panics on malformed input.

use chrono::{DateTime, Duration, Timelike, Utc};

/// Compute the next run instant for a 5-field cron string, relative to `after`.
pub fn next_run_from_cron(cron: &str, after: DateTime<Utc>) -> DateTime<Utc> {
    let parts: Vec<&str> = cron.trim().split_whitespace().collect();
    if parts.len() < 5 {
        return after + Duration::hours(24);
    }
    let min_part = parts[0];
    let hour_part = parts[1];

    // Every N minutes: */N * * * *
    if let Some(rest) = min_part.strip_prefix("*/") {
        if hour_part == "*" {
            if let Ok(n) = rest.parse::<i64>() {
                if n > 0 {
                    return after + Duration::minutes(n);
                }
            }
        }
    }

    // Every minute: * * * * *
    if min_part == "*" && hour_part == "*" {
        return after + Duration::minutes(1);
    }

    // Every N hours: M */N * * *
    if let Some(rest) = hour_part.strip_prefix("*/") {
        if let Ok(n) = rest.parse::<i64>() {
            if n > 0 {
                return after + Duration::hours(n);
            }
        }
    }

    // Hourly at a specific minute: M * * * *
    if !min_part.contains('*') && hour_part == "*" {
        if let Ok(target_min) = min_part.parse::<u32>() {
            let mut next = after
                .with_minute(target_min.min(59))
                .and_then(|t| t.with_second(0))
                .unwrap_or(after);
            if next <= after {
                next += Duration::hours(1);
            }
            return next;
        }
    }

    // Daily at a specific time: M H * * *
    if !min_part.contains('*') && !hour_part.contains('*') {
        if let (Ok(target_min), Ok(target_hour)) =
            (min_part.parse::<u32>(), hour_part.parse::<u32>())
        {
            let mut next = after
                .with_hour(target_hour.min(23))
                .and_then(|t| t.with_minute(target_min.min(59)))
                .and_then(|t| t.with_second(0))
                .unwrap_or(after);
            if next <= after {
                next += Duration::days(1);
            }
            return next;
        }
    }

    // Fallback: 24h.
    after + Duration::hours(24)
}
