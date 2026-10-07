//! Shared Redis connection of the api (job queues kex:jobs / fuse:jobs, small
//! key/value state).
//!
//! The connection is a redis-rs `ConnectionManager`: when Redis restarts, the
//! dropped socket is replaced in the background. The helpers below also retry a
//! command that hit the dropped socket, so the first enqueue after a restart is
//! not lost. (Before, a single `MultiplexedConnection` was opened at boot and
//! never replaced: after a Redis restart every LPUSH failed until the api itself
//! was restarted.)

use redis::aio::ConnectionManager;
use redis::{Client, Cmd, FromRedisValue, RedisResult};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Attempts per command when the connection is broken (first try + retries).
const ATTEMPTS: u32 = 4;
/// Pause before retry n is `RETRY_BASE * 2^(n-1)`: 250 ms, 500 ms, 1 s.
const RETRY_BASE: Duration = Duration::from_millis(250);

pub async fn connect(url: &str) -> Arc<Mutex<ConnectionManager>> {
    let client = Client::open(url).expect("Redis URL invalid");
    let conn = ConnectionManager::new(client).await
        .expect("Redis connection failed");
    Arc::new(Mutex::new(conn))
}

/// A broken or refused connection (Redis restarting) is worth another try on the
/// manager's fresh connection; a Redis-side error (WRONGTYPE, NOAUTH, ...) is not.
fn is_transient(e: &redis::RedisError) -> bool {
    e.is_io_error() || e.is_connection_dropped() || e.is_connection_refusal() || e.is_unrecoverable_error()
}

async fn query<T: FromRedisValue>(conn: &Arc<Mutex<ConnectionManager>>, cmd: &Cmd) -> RedisResult<T> {
    let mut attempt = 1;
    loop {
        // Clone the manager out of the lock: it is a cheap handle onto the same
        // connection, and a retry pause must not block other callers.
        let mut c = conn.lock().await.clone();
        match cmd.query_async(&mut c).await {
            Err(e) if attempt < ATTEMPTS && is_transient(&e) => {
                tracing::warn!("redis: {e}; retrying ({attempt}/{})", ATTEMPTS - 1);
                tokio::time::sleep(RETRY_BASE * 2u32.pow(attempt - 1)).await;
                attempt += 1;
            }
            other => return other,
        }
    }
}

pub async fn lpush(conn: &Arc<Mutex<ConnectionManager>>, key: &str, value: &str) -> RedisResult<()> {
    query(conn, redis::cmd("LPUSH").arg(key).arg(value)).await
}

pub async fn llen(conn: &Arc<Mutex<ConnectionManager>>, key: &str) -> RedisResult<i64> {
    query(conn, redis::cmd("LLEN").arg(key)).await
}

/// Atomically move one element from the tail of `src` to the head of `dst`
/// (LMOVE RIGHT LEFT). Returns the moved element, or None when `src` is empty.
/// Atomic per element — a crash mid-drain can never lose a payload the way a
/// separate RPOP+LPUSH could.
pub async fn lmove(conn: &Arc<Mutex<ConnectionManager>>, src: &str, dst: &str) -> RedisResult<Option<String>> {
    query(conn, redis::cmd("LMOVE").arg(src).arg(dst).arg("RIGHT").arg("LEFT")).await
}

pub async fn set(conn: &Arc<Mutex<ConnectionManager>>, key: &str, value: &str) -> RedisResult<()> {
    query(conn, redis::cmd("SET").arg(key).arg(value)).await
}

pub async fn get(conn: &Arc<Mutex<ConnectionManager>>, key: &str) -> RedisResult<Option<String>> {
    query(conn, redis::cmd("GET").arg(key)).await
}

/// Subscribe to `channels` and hand every payload to `on_message`, forever.
/// When the subscription breaks (Redis restart: the message stream simply ends)
/// or cannot be opened, wait and subscribe again, 1 s doubling up to 30 s.
/// Messages published while no subscription exists are lost (pub/sub semantics);
/// before, the subscriber task ended on the first break and job results were
/// never processed again until the api restarted.
pub async fn subscribe_forever<F, Fut>(url: &str, channels: &[&str], mut on_message: F)
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    use futures::StreamExt;
    const MAX_BACKOFF: Duration = Duration::from_secs(30);
    let mut backoff = Duration::from_secs(1);
    loop {
        let subscribed: RedisResult<redis::aio::PubSub> = async {
            let mut ps = Client::open(url)?.get_async_pubsub().await?;
            ps.subscribe(channels).await?;
            Ok(ps)
        }.await;
        match subscribed {
            Ok(ps) => {
                tracing::info!("redis: subscribed to {channels:?}");
                backoff = Duration::from_secs(1);
                let mut stream = ps.into_on_message();
                while let Some(msg) = stream.next().await {
                    on_message(msg.get_payload().unwrap_or_default()).await;
                }
                tracing::warn!("redis: subscription to {channels:?} ended (Redis restarted?); resubscribing");
            }
            Err(e) => tracing::warn!(
                "redis: subscribe to {channels:?} failed: {}; retrying in {backoff:?}",
                crate::services::redact::redact_url(&e.to_string())
            ),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    /// Minimal RESP server. The FIRST client connection is closed right after it
    /// answered one data command (a Redis restart from the client's view); later
    /// connections are served normally. Counts the LPUSHes it answered.
    async fn fake_redis() -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let lpushes = Arc::new(AtomicUsize::new(0));
        let counter = lpushes.clone();
        tokio::spawn(async move {
            let mut first = true;
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                let drop_after = if first { Some(1) } else { None };
                first = false;
                tokio::spawn(serve(sock, drop_after, counter.clone()));
            }
        });
        (format!("redis://127.0.0.1:{}", addr.port()), lpushes)
    }

    async fn read_command(r: &mut BufReader<TcpStream>) -> Option<Vec<String>> {
        let mut line = String::new();
        if r.read_line(&mut line).await.ok()? == 0 { return None; }
        let n: usize = line.trim()[1..].parse().ok()?;
        let mut parts = Vec::with_capacity(n);
        for _ in 0..n {
            line.clear();
            r.read_line(&mut line).await.ok()?;
            let len: usize = line.trim()[1..].parse().ok()?;
            let mut buf = vec![0u8; len + 2];
            r.read_exact(&mut buf).await.ok()?;
            parts.push(String::from_utf8_lossy(&buf[..len]).into_owned());
        }
        Some(parts)
    }

    async fn serve(sock: TcpStream, drop_after: Option<usize>, lpushes: Arc<AtomicUsize>) {
        let mut r = BufReader::new(sock);
        let mut answered = 0;
        while let Some(cmd) = read_command(&mut r).await {
            let name = cmd[0].to_ascii_uppercase();
            let reply: &[u8] = match name.as_str() {
                "CLIENT" => b"+OK\r\n",
                "PING" => b"+PONG\r\n",
                _ => {
                    if name == "LPUSH" { lpushes.fetch_add(1, Ordering::SeqCst); }
                    answered += 1;
                    b":1\r\n"
                }
            };
            if r.get_mut().write_all(reply).await.is_err() { return; }
            if drop_after.is_some_and(|n| answered >= n) { return; } // socket dropped here
        }
    }

    #[tokio::test]
    async fn enqueue_after_redis_restart_succeeds() {
        let (url, lpushes) = fake_redis().await;
        let conn = connect(&url).await;
        lpush(&conn, "kex:jobs", "job-1").await.expect("first enqueue");
        // The server has closed the connection the api was using (Redis restart).
        tokio::time::sleep(Duration::from_millis(50)).await;
        lpush(&conn, "kex:jobs", "job-2").await.expect("enqueue after restart must not fail");
        assert_eq!(lpushes.load(Ordering::SeqCst), 2);
        assert_eq!(llen(&conn, "kex:jobs").await.unwrap(), 1);
    }

    fn bulk(s: &str) -> String { format!("${}\r\n{}\r\n", s.len(), s) }

    /// Pub/sub fake: every connection confirms SUBSCRIBE, pushes one message
    /// ("msg-<n>" for the n-th connection) and then closes, like a Redis restart.
    async fn fake_pubsub() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                n += 1;
                tokio::spawn(async move {
                    let mut r = BufReader::new(sock);
                    while let Some(cmd) = read_command(&mut r).await {
                        match cmd[0].to_ascii_uppercase().as_str() {
                            "SUBSCRIBE" => {
                                let mut out = String::new();
                                for (i, ch) in cmd[1..].iter().enumerate() {
                                    out += &format!("*3\r\n{}{}:{}\r\n", bulk("subscribe"), bulk(ch), i + 1);
                                }
                                let _ = r.get_mut().write_all(out.as_bytes()).await;
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                let msg = format!("*3\r\n{}{}{}", bulk("message"), bulk(&cmd[1]), bulk(&format!("msg-{n}")));
                                let _ = r.get_mut().write_all(msg.as_bytes()).await;
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                return; // connection dropped
                            }
                            _ => { let _ = r.get_mut().write_all(b"+OK\r\n").await; }
                        }
                    }
                });
            }
        });
        format!("redis://127.0.0.1:{}", addr.port())
    }

    #[tokio::test]
    async fn result_subscription_survives_redis_restart() {
        let url = fake_pubsub().await;
        let got = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = got.clone();
        let task = tokio::spawn(async move {
            subscribe_forever(&url, &["kex:results"], move |p| {
                sink.lock().unwrap().push(p);
                async {}
            }).await;
        });
        for _ in 0..100 {
            if got.lock().unwrap().len() >= 2 { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        task.abort();
        let got = got.lock().unwrap().clone();
        assert!(got.len() >= 2, "expected messages from two subscriptions, got {got:?}");
        assert_eq!(&got[..2], ["msg-1", "msg-2"]);
    }

    #[test]
    fn server_errors_are_not_retried() {
        let e = redis::RedisError::from((redis::ErrorKind::ResponseError, "WRONGTYPE"));
        assert!(!is_transient(&e));
        let io = redis::RedisError::from(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
        assert!(is_transient(&io));
    }
}
