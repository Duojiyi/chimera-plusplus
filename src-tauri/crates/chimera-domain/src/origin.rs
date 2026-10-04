//! Same-origin comparison, shared by everything that follows a redirect.
//!
//! This lives in the domain layer because two adapters need it and adapters may
//! not depend on each other (G1, enforced by
//! `scripts/verify-v2-architecture.mjs`). The alternative — a copy in
//! `chimera-provider` and another in `chimera-runtime` — is how one of them
//! eventually gets a fix the other does not, on a rule whose whole job is to
//! stop a credential leaving the host the user approved.
//!
//! It is a pure function over two strings with no I/O, which is what makes the
//! domain layer the correct home rather than a convenient one.

use url::Url;

/// May a request be followed from `from` to `to` while still carrying
/// credentials?
///
/// True only when both share an origin — scheme, host and port. A different
/// port is a different origin even on the same host, and a subdomain is not the
/// same origin as its parent.
///
/// Fails closed: anything that cannot be parsed is refused. A redirect target
/// we cannot understand is not one we should send an `Authorization` header to.
pub fn same_origin(from: &str, to: &str) -> bool {
    match (Url::parse(from), Url::parse(to)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}
