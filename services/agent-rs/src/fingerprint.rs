use sha2::{Digest, Sha256};
use sysinfo::System;

pub async fn compute() -> String {
    tokio::task::spawn_blocking(|| {
        let mut sys = System::new_all();
        sys.refresh_all();

        let cpu = sys.cpus().first()
            .map(|c| format!("{} {}", c.brand(), c.frequency()))
            .unwrap_or_else(|| "unknown-cpu".into());

        let mac = sysinfo::Networks::new_with_refreshed_list()
            .iter()
            .find(|(_, n)| !n.mac_address().is_unspecified())
            .map(|(_, n)| n.mac_address().to_string())
            .unwrap_or_else(|| "00:00:00:00:00:00".into());

        let disk = sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .next()
            .map(|d| d.name().to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown-disk".into());

        let raw = format!("{}::{}::{}", cpu, disk, mac);
        let mut hasher = Sha256::new();
        hasher.update(raw.as_bytes());
        hex::encode(hasher.finalize())
    })
    .await
    .unwrap_or_else(|_| "unknown".into())
}
