use redis::aio::MultiplexedConnection;
use redis::Client;
use std::sync::Arc;
use tokio::sync::Mutex;

pub async fn connect(url: &str) -> Arc<Mutex<MultiplexedConnection>> {
    let client = Client::open(url).expect("Redis URL invalid");
    let conn = client.get_multiplexed_async_connection().await
        .expect("Redis connection failed");
    Arc::new(Mutex::new(conn))
}

pub async fn lpush(conn: &Arc<Mutex<MultiplexedConnection>>, key: &str, value: &str) -> redis::RedisResult<()> {
    let mut c = conn.lock().await;
    redis::cmd("LPUSH").arg(key).arg(value).query_async(&mut *c).await
}

pub async fn llen(conn: &Arc<Mutex<MultiplexedConnection>>, key: &str) -> redis::RedisResult<i64> {
    let mut c = conn.lock().await;
    redis::cmd("LLEN").arg(key).query_async(&mut *c).await
}

pub async fn set(conn: &Arc<Mutex<MultiplexedConnection>>, key: &str, value: &str) -> redis::RedisResult<()> {
    let mut c = conn.lock().await;
    redis::cmd("SET").arg(key).arg(value).query_async(&mut *c).await
}

pub async fn get(conn: &Arc<Mutex<MultiplexedConnection>>, key: &str) -> redis::RedisResult<Option<String>> {
    let mut c = conn.lock().await;
    redis::cmd("GET").arg(key).query_async(&mut *c).await
}
