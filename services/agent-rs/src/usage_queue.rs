use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecord {
    pub action:          String,
    pub chars_processed: u64,
    pub credits_spent:   i64,
    pub timestamp:       String,
}

#[derive(Default)]
pub struct UsageQueue {
    records: Vec<UsageRecord>,
}

impl UsageQueue {
    pub fn new() -> Self { Self::default() }

    pub fn enqueue(&mut self, action: String, chars_processed: u64, credits_spent: i64) {
        self.records.push(UsageRecord {
            action,
            chars_processed,
            credits_spent,
            timestamp: Utc::now().to_rfc3339(),
        });
    }

    pub fn flush(&mut self) -> Vec<UsageRecord> {
        std::mem::take(&mut self.records)
    }

    pub fn size(&self) -> usize { self.records.len() }
}
