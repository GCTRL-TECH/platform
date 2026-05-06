pub fn calculate(action: &str, chars: u64) -> i64 {
    match action {
        "kex_ner"     => ((chars as f64 / 1000.0) * 1.0).ceil() as i64,
        "kex_extract" => ((chars as f64 / 1000.0) * 25.0).ceil() as i64,
        "fuse_merge"  => 10,
        "talk_query"  => 5,
        _             => 1,
    }
}
