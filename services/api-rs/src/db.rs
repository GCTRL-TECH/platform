use sqlx::{postgres::PgPoolOptions, PgPool};

pub async fn connect(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("Failed to connect to PostgreSQL")
}

/// The migrations compiled into this binary (`migrations/`).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// One row of `_sqlx_migrations`: version, checksum, success.
pub type AppliedMigration = (i64, Vec<u8>, bool);

/// For an instance that must not migrate (`GCTRL_BACKGROUND_JOBS=off`, a second API
/// next to the productive one on the same database): does the database carry exactly
/// the migrations of this binary? Only reads `_sqlx_migrations`. `Err` is the reason to
/// refuse the start.
pub async fn verify_schema(db: &PgPool) -> Result<(), String> {
    let applied: Vec<AppliedMigration> =
        sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(db)
            .await
            .map_err(|e| {
                format!("cannot read _sqlx_migrations ({e}); the instance with background jobs on migrates the database, start it first")
            })?;
    let binary: Vec<(i64, &[u8])> = MIGRATOR
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .map(|m| (m.version, m.checksum.as_ref()))
        .collect();
    schema_matches(&binary, &applied)
}

/// PURE: the checks `Migrator::run` makes before it migrates (failed migration, applied
/// version unknown to the binary, checksum), plus the one it would fix by migrating
/// (binary version not applied). `Err` names every mismatch.
pub fn schema_matches(binary: &[(i64, &[u8])], applied: &[AppliedMigration]) -> Result<(), String> {
    let mut why = Vec::new();
    let failed: Vec<i64> = applied.iter().filter(|a| !a.2).map(|a| a.0).collect();
    if !failed.is_empty() {
        why.push(format!("migration(s) {failed:?} failed on this database"));
    }
    let unknown: Vec<i64> = applied.iter().map(|a| a.0).filter(|v| !binary.iter().any(|b| b.0 == *v)).collect();
    if !unknown.is_empty() {
        why.push(format!(
            "the database is newer than this binary (migration(s) {unknown:?} unknown here); run the version of the productive instance"
        ));
    }
    let pending: Vec<i64> = binary.iter().map(|b| b.0).filter(|v| !applied.iter().any(|a| a.0 == *v)).collect();
    if !pending.is_empty() {
        why.push(format!(
            "this binary is newer than the database (migration(s) {pending:?} not applied) and never migrates with \
             GCTRL_BACKGROUND_JOBS=off; update the productive instance first, it migrates on start"
        ));
    }
    let changed: Vec<i64> = binary
        .iter()
        .filter(|b| applied.iter().any(|a| a.0 == b.0 && a.1.as_slice() != b.1))
        .map(|b| b.0)
        .collect();
    if !changed.is_empty() {
        why.push(format!("migration(s) {changed:?} differ between this binary and the database (checksum)"));
    }
    if why.is_empty() {
        Ok(())
    } else {
        Err(why.join("; "))
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    fn applied(rows: &[(i64, &[u8], bool)]) -> Vec<AppliedMigration> {
        rows.iter().map(|(v, c, ok)| (*v, c.to_vec(), *ok)).collect()
    }

    #[test]
    fn same_migrations_pass() {
        let binary: [(i64, &[u8]); 2] = [(1, b"a"), (2, b"b")];
        assert_eq!(schema_matches(&binary, &applied(&[(1, b"a", true), (2, b"b", true)])), Ok(()));
    }

    #[test]
    fn a_newer_binary_or_a_newer_database_is_refused() {
        let binary: [(i64, &[u8]); 3] = [(1, b"a"), (2, b"b"), (3, b"c")];
        let err = schema_matches(&binary, &applied(&[(1, b"a", true), (2, b"b", true)])).unwrap_err();
        assert!(err.contains("binary is newer than the database") && err.contains("[3]"), "{err}");

        let err = schema_matches(&binary[..2], &applied(&[(1, b"a", true), (2, b"b", true), (3, b"c", true)])).unwrap_err();
        assert!(err.contains("database is newer than this binary") && err.contains("[3]"), "{err}");
    }

    #[test]
    fn a_failed_or_changed_migration_is_refused() {
        let binary: [(i64, &[u8]); 2] = [(1, b"a"), (2, b"b")];
        let err = schema_matches(&binary, &applied(&[(1, b"a", true), (2, b"b", false)])).unwrap_err();
        assert!(err.contains("[2] failed"), "{err}");
        let err = schema_matches(&binary, &applied(&[(1, b"a", true), (2, b"x", true)])).unwrap_err();
        assert!(err.contains("[2] differ"), "{err}");
    }

    #[test]
    fn the_compiled_migrations_have_unique_versions() {
        let mut v: Vec<i64> = MIGRATOR.iter().filter(|m| !m.migration_type.is_down_migration()).map(|m| m.version).collect();
        let n = v.len();
        v.dedup();
        assert!(n > 0 && v.len() == n);
    }
}
