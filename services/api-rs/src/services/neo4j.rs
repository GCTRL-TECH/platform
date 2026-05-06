use std::sync::Arc;

pub async fn connect(uri: &str, user: &str, password: &str) -> Arc<neo4rs::Graph> {
    let config = neo4rs::ConfigBuilder::default()
        .uri(uri)
        .user(user)
        .password(password)
        .max_connections(50)
        .build()
        .expect("Neo4j config error");
    Arc::new(neo4rs::Graph::connect(config).await.expect("Neo4j connection failed"))
}
