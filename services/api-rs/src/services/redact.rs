//! Credential-safe rendering of connection URLs for logs and API responses.
//!
//! `redis://default:<pw>@gctrl-redis:6379` must never reach a log line or a JSON
//! body; [`redact_url`] turns it into `redis://default:***@gctrl-redis:6379`.

use once_cell::sync::Lazy;
use regex::{Captures, Regex};

// scheme://userinfo@ — userinfo greedy up to the LAST '@' before the path, so an
// unencoded '@' inside a password is masked as well.
static CRED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*://)(?P<userinfo>[^/\s]*)@").unwrap()
});

/// Mask the credentials of every URL inside `text` (`user:***@`, or `***@` for a
/// bare token). Text without credentials comes back unchanged.
pub fn redact_url(text: &str) -> String {
    CRED_RE
        .replace_all(text, |c: &Captures| {
            let userinfo = &c["userinfo"];
            let masked = match userinfo.split_once(':') {
                Some((user, _pw)) => format!("{user}:***"),
                None => "***".to_string(),
            };
            format!("{}{}@", &c["scheme"], masked)
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    #[test]
    fn masks_password() {
        assert_eq!(
            redact_url("redis://default:s3cret@gctrl-redis:6379"),
            "redis://default:***@gctrl-redis:6379"
        );
    }

    #[test]
    fn masks_empty_user_and_bare_token() {
        assert_eq!(redact_url("redis://:pw@redis:6379/0"), "redis://:***@redis:6379/0");
        assert_eq!(redact_url("https://tok@github.com/x"), "https://***@github.com/x");
    }

    #[test]
    fn masks_password_containing_at() {
        assert_eq!(
            redact_url("postgres://GCTRL:p@ss@postgres:5432/GCTRL"),
            "postgres://GCTRL:***@postgres:5432/GCTRL"
        );
    }

    #[test]
    fn leaves_plain_urls_alone() {
        for u in ["redis://redis:6379", "http://qdrant:6333", "bolt://neo4j:7687", "postgres (bundled)", ""] {
            assert_eq!(redact_url(u), u);
        }
    }

    #[test]
    fn masks_inside_messages() {
        assert_eq!(
            redact_url("connect to redis://u:pw@h:6379 failed; retry http://a:b@c/"),
            "connect to redis://u:***@h:6379 failed; retry http://a:***@c/"
        );
    }
}
