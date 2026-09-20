//! Sync-only regression tests. All HTTP requests target ephemeral loopback servers.
//! These tests do not read local databases/skills or use real cloud credentials.

use super::*;
use crate::services::{s3, s3_sync, webdav, webdav_sync};
use crate::settings::{S3SyncSettings, WebDavSyncSettings};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use std::sync::{Arc, Mutex};

fn snapshot(label: &str) -> LocalSnapshot {
    snapshot_from_artifacts(
        format!("sql-{label}").into_bytes(),
        format!("zip-{label}").into_bytes(),
        "test-device".to_string(),
    )
    .unwrap()
}

#[test]
fn new_snapshots_use_distinct_generations_even_with_identical_content() {
    let a = snapshot("same");
    let b = snapshot("same");
    assert_eq!(a.manifest.snapshot_id, b.manifest.snapshot_id);
    assert_ne!(a.manifest.generation, b.manifest.generation);
    let serialized = serde_json::to_value(&a.manifest).unwrap();
    assert_eq!(serialized["version"], MANIFEST_VERSION);
    assert!(serialized["generation"].as_str().is_some());
    let parsed: SyncManifest = serde_json::from_slice(&a.manifest_bytes).unwrap();
    validate_manifest_compat(&parsed, RemoteLayout::Current).unwrap();
    assert_eq!(
        a.artifact_paths().unwrap().0,
        artifact_relative_path(&parsed, REMOTE_DB_SQL).unwrap()
    );
}

#[test]
fn legacy_manifest_without_generation_keeps_fixed_paths() {
    let mut value = serde_json::to_value(snapshot("legacy").manifest).unwrap();
    value["version"] = PROTOCOL_VERSION.into();
    value.as_object_mut().unwrap().remove("generation");
    let mut manifest: SyncManifest = serde_json::from_value(value).unwrap();
    validate_manifest_compat(&manifest, RemoteLayout::Current).unwrap();
    assert!(serde_json::to_value(&manifest)
        .unwrap()
        .get("generation")
        .is_none());
    for name in [REMOTE_DB_SQL, REMOTE_SKILLS_ZIP] {
        assert_eq!(artifact_relative_path(&manifest, name).unwrap(), name);
    }
    manifest.db_compat_version = None;
    validate_manifest_compat(&manifest, RemoteLayout::Legacy).unwrap();
    assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
}

#[test]
fn generation_paths_reject_untrusted_components_and_unknown_versions() {
    let original = snapshot("paths").manifest;
    for bad in [
        "",
        ".",
        "..",
        "../other",
        "a/b",
        "a\\b",
        "/absolute",
        "https://other.invalid/x",
        "%2e%2e",
        "?query",
        "#fragment",
        "0123456789abcdef0123456789abcdeF",
        "0123456789abcdef0123456789abcdef/",
    ] {
        let mut manifest = original.clone();
        manifest.generation = Some(bad.to_string());
        assert!(
            validate_manifest_compat(&manifest, RemoteLayout::Current).is_err(),
            "{bad}"
        );
        assert!(
            artifact_relative_path(&manifest, REMOTE_DB_SQL).is_err(),
            "{bad}"
        );
    }
    assert!(artifact_relative_path(&original, "../manifest.json").is_err());
    assert!(artifact_relative_path(&original, "manifest.json").is_err());
    for version in [0, 1, MANIFEST_VERSION + 1, u32::MAX] {
        let mut manifest = original.clone();
        manifest.version = version;
        assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
        let remote = (
            serde_json::to_vec(&manifest).unwrap(),
            Some("\"old\"".to_string()),
        );
        assert!(
            manifest_write_condition(Some(&remote), None, None, UploadOptions { force: true })
                .is_err()
        );
    }
    let mut missing = original.clone();
    missing.generation = None;
    assert!(validate_manifest_compat(&missing, RemoteLayout::Current).is_err());
    missing = original;
    missing.version = PROTOCOL_VERSION;
    assert!(validate_manifest_compat(&missing, RemoteLayout::Current).is_err());
}

#[test]
fn v3_manifest_requires_complete_artifact_set_and_valid_digest() {
    let mut manifest = snapshot("invalid").manifest;
    manifest.artifacts.remove(REMOTE_SKILLS_ZIP);
    assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
    let mut manifest = snapshot("invalid").manifest;
    manifest.snapshot_id = "wrong".to_string();
    assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
    let mut manifest = snapshot("invalid").manifest;
    manifest.artifacts.get_mut(REMOTE_DB_SQL).unwrap().size = MAX_SYNC_ARTIFACT_BYTES + 1;
    assert!(validate_manifest_compat(&manifest, RemoteLayout::Current).is_err());
}

#[test]
fn preflight_distinguishes_missing_etag_from_missing_manifest() {
    let options = UploadOptions::default();
    assert_eq!(
        manifest_write_condition(None, None, None, options).unwrap(),
        WriteCondition::IfNoneMatch
    );
    assert_eq!(
        WriteCondition::IfNoneMatch.header(),
        Some(("if-none-match", "*"))
    );
    let snap = snapshot("etagless");
    let remote = (snap.manifest_bytes, None);
    assert!(manifest_write_condition(Some(&remote), None, None, options).is_err());
    assert_eq!(
        manifest_write_condition(Some(&remote), None, Some(&snap.manifest_hash), options).unwrap(),
        WriteCondition::Unconditional
    );
    assert!(manifest_write_condition(Some(&remote), None, Some("stale-hash"), options).is_err());
    let remote = (remote.0, Some("\"etag-1\"".to_string()));
    let condition =
        manifest_write_condition(Some(&remote), Some("\"etag-1\""), None, options).unwrap();
    assert_eq!(condition.header(), Some(("if-match", "\"etag-1\"")));
    // An unchanged ETag cannot override a known changed body.
    assert!(manifest_write_condition(
        Some(&remote),
        Some("\"etag-1\""),
        Some("stale-hash"),
        options
    )
    .is_err());
    let remote = (remote.0, Some("W/\"weak\"".to_string()));
    assert_eq!(
        manifest_write_condition(Some(&remote), None, Some(&snap.manifest_hash), options).unwrap(),
        WriteCondition::Unconditional
    );
}

#[derive(Clone, Copy, Debug)]
enum Transport {
    WebDav,
    S3,
}

#[derive(Default)]
struct Store {
    objects: BTreeMap<String, (Vec<u8>, String)>,
    requests: Vec<(String, String, HeaderMap)>,
    published: Vec<(String, SyncManifest)>,
    enforce_conditions: bool,
    etag_headers: bool,
    // suffix, response, commit despite error (lost acknowledgement / partial artifact)
    failure: Option<(String, StatusCode, bool)>,
    sequence: usize,
}

struct TestServer {
    url: String,
    store: Arc<Mutex<Store>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    async fn new(enforce_conditions: bool, etag_headers: bool) -> Self {
        let store = Arc::new(Mutex::new(Store {
            enforce_conditions,
            etag_headers,
            ..Store::default()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .fallback(serve_object)
            .with_state(store.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self { url, store, task }
    }

    fn webdav_settings(&self) -> WebDavSyncSettings {
        WebDavSyncSettings {
            base_url: self.url.clone(),
            remote_root: "root".into(),
            profile: "default".into(),
            ..WebDavSyncSettings::default()
        }
    }

    fn s3_settings(&self) -> S3SyncSettings {
        S3SyncSettings {
            endpoint: self.url.clone(),
            bucket: "bucket".into(),
            remote_root: "root".into(),
            profile: "default".into(),
            ..S3SyncSettings::default()
        }
    }

    fn creds(&self) -> s3::S3Credentials {
        s3::S3Credentials {
            access_key_id: "test-key".into(),
            secret_access_key: "test-secret".into(),
            region: "us-east-1".into(),
            bucket: "bucket".into(),
            endpoint: self.url.clone(),
        }
    }

    fn prefix(kind: Transport, layout: RemoteLayout) -> String {
        let bucket = if matches!(kind, Transport::S3) {
            "/bucket"
        } else {
            ""
        };
        let db = if layout == RemoteLayout::Current {
            "/db-v6"
        } else {
            ""
        };
        format!("{bucket}/root/v2{db}/default/")
    }

    fn current(&self, kind: Transport) -> Option<(Vec<u8>, Option<String>)> {
        let key = format!("{}manifest.json", Self::prefix(kind, RemoteLayout::Current));
        let store = self.store.lock().unwrap();
        store
            .objects
            .get(&key)
            .map(|(bytes, etag)| (bytes.clone(), store.etag_headers.then(|| etag.clone())))
    }

    async fn publish(
        &self,
        kind: Transport,
        snap: LocalSnapshot,
        condition: &WriteCondition,
    ) -> Result<Option<String>, AppError> {
        match kind {
            Transport::WebDav => {
                webdav_sync::publish_snapshot(&self.webdav_settings(), &None, snap, condition).await
            }
            Transport::S3 => {
                s3_sync::publish_snapshot(&self.s3_settings(), &self.creds(), snap, condition).await
            }
        }
    }

    async fn read_artifact(
        &self,
        kind: Transport,
        layout: RemoteLayout,
        manifest: &SyncManifest,
        name: &str,
    ) -> Result<Vec<u8>, AppError> {
        match kind {
            Transport::WebDav => {
                webdav_sync::download_and_verify(
                    &self.webdav_settings(),
                    &None,
                    layout,
                    name,
                    manifest,
                )
                .await
            }
            Transport::S3 => {
                s3_sync::download_and_verify(&self.s3_settings(), &self.creds(), name, manifest)
                    .await
            }
        }
    }

    fn assert_publications_intact(&self) {
        let store = self.store.lock().unwrap();
        assert!(!store.published.is_empty());
        for (prefix, manifest) in &store.published {
            validate_manifest_compat(manifest, RemoteLayout::Current).unwrap();
            for name in [REMOTE_DB_SQL, REMOTE_SKILLS_ZIP] {
                let key = format!(
                    "{prefix}{}",
                    artifact_relative_path(manifest, name).unwrap()
                );
                let (bytes, _) = store
                    .objects
                    .get(&key)
                    .expect("referenced artifact must exist");
                verify_artifact(bytes, name, &manifest.artifacts[name]).unwrap();
            }
        }
        assert!(!store
            .requests
            .iter()
            .any(|(method, _, _)| method == "DELETE"));
    }
}

async fn serve_object(
    State(state): State<Arc<Mutex<Store>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let key = uri.path().to_string();
    let mut store = state.lock().unwrap();
    store
        .requests
        .push((method.to_string(), key.clone(), headers.clone()));
    if method.as_str() == "MKCOL" {
        return StatusCode::CREATED.into_response();
    }
    if method == Method::GET || method == Method::HEAD {
        return match store.objects.get(&key) {
            Some((bytes, etag)) => {
                let mut response = bytes.clone().into_response();
                if store.etag_headers {
                    response.headers_mut().insert("etag", etag.parse().unwrap());
                }
                response
            }
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if method != Method::PUT {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if store.enforce_conditions {
        if headers.get("if-none-match").is_some_and(|v| v == "*")
            && store.objects.contains_key(&key)
        {
            return StatusCode::PRECONDITION_FAILED.into_response();
        }
        if let Some(expected) = headers.get("if-match") {
            if store.objects.get(&key).map(|(_, etag)| etag.as_str()) != expected.to_str().ok() {
                return StatusCode::PRECONDITION_FAILED.into_response();
            }
        }
    }
    let failure = store
        .failure
        .clone()
        .filter(|(suffix, _, _)| key.ends_with(suffix.as_str()));
    if let Some((_, status, false)) = &failure {
        return (*status).into_response();
    }
    store.sequence += 1;
    let etag = format!("\"{}\"", store.sequence);
    let mut bytes = body.to_vec();
    let manifest_prefix = key.strip_suffix(REMOTE_MANIFEST);
    if failure.is_some() && manifest_prefix.is_none() {
        bytes.truncate(bytes.len() / 2);
    }
    store
        .objects
        .insert(key.clone(), (bytes.clone(), etag.clone()));
    if let Some(prefix) = manifest_prefix {
        let manifest = serde_json::from_slice(&bytes).unwrap();
        store.published.push((prefix.to_string(), manifest));
    }
    let status = failure
        .map(|(_, status, _)| status)
        .unwrap_or(StatusCode::CREATED);
    let mut response = status.into_response();
    if store.etag_headers {
        response.headers_mut().insert("etag", etag.parse().unwrap());
    }
    response
}

#[tokio::test]
async fn competing_first_publications_use_create_only_and_keep_winner_intact() {
    for kind in [Transport::WebDav, Transport::S3] {
        let server = TestServer::new(true, true).await;
        let condition = WriteCondition::IfNoneMatch;
        let (a, b) = tokio::join!(
            server.publish(kind, snapshot("a"), &condition),
            server.publish(kind, snapshot("b"), &condition),
        );
        assert_ne!(
            a.is_ok(),
            b.is_ok(),
            "exactly one first publication wins: {kind:?}"
        );
        server.assert_publications_intact();
        let store = server.store.lock().unwrap();
        assert_eq!(store.published.len(), 1);
        for (method, _, headers) in &store.requests {
            if method == "PUT" {
                assert_eq!(headers.get("if-none-match").unwrap(), "*");
                if matches!(kind, Transport::S3) {
                    assert!(headers["authorization"]
                        .to_str()
                        .unwrap()
                        .contains("if-none-match"));
                }
            }
        }
    }
}

#[tokio::test]
async fn competing_updates_keep_every_published_generation_and_old_download_readable() {
    for kind in [Transport::WebDav, Transport::S3] {
        let server = TestServer::new(true, true).await;
        let first = snapshot("old");
        let old_manifest = first.manifest.clone();
        let etag = server
            .publish(kind, first, &WriteCondition::IfNoneMatch)
            .await
            .unwrap()
            .unwrap();
        let remote = server.current(kind).unwrap();
        let condition =
            manifest_write_condition(Some(&remote), Some(&etag), None, UploadOptions::default())
                .unwrap();
        let (a, b) = tokio::join!(
            server.publish(kind, snapshot("a"), &condition),
            server.publish(kind, snapshot("b"), &condition),
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(server.store.lock().unwrap().published.len(), 2);
        server.assert_publications_intact();
        // A reader holding the old manifest is not invalidated by a publication.
        assert_eq!(
            server
                .read_artifact(kind, RemoteLayout::Current, &old_manifest, REMOTE_DB_SQL)
                .await
                .unwrap(),
            b"sql-old"
        );
        assert_eq!(
            server
                .read_artifact(
                    kind,
                    RemoteLayout::Current,
                    &old_manifest,
                    REMOTE_SKILLS_ZIP
                )
                .await
                .unwrap(),
            b"zip-old"
        );
        let store = server.store.lock().unwrap();
        for (method, path, headers) in &store.requests {
            if method == "PUT"
                && path.ends_with(REMOTE_MANIFEST)
                && headers.contains_key("if-match")
                && matches!(kind, Transport::S3)
            {
                assert!(headers["authorization"]
                    .to_str()
                    .unwrap()
                    .contains("if-match"));
            }
        }
        assert!(!store.requests.iter().any(|(method, _, _)| method == "HEAD"));
    }
}

#[tokio::test]
async fn failures_at_each_stage_preserve_previous_snapshot() {
    for kind in [Transport::WebDav, Transport::S3] {
        for (suffix, status, commit) in [
            (REMOTE_DB_SQL, StatusCode::INTERNAL_SERVER_ERROR, true),
            (REMOTE_SKILLS_ZIP, StatusCode::INTERNAL_SERVER_ERROR, true),
            (REMOTE_SKILLS_ZIP, StatusCode::ACCEPTED, false),
            (REMOTE_MANIFEST, StatusCode::INTERNAL_SERVER_ERROR, false),
            (REMOTE_MANIFEST, StatusCode::INTERNAL_SERVER_ERROR, true),
        ] {
            let server = TestServer::new(true, true).await;
            let etag = server
                .publish(kind, snapshot("old"), &WriteCondition::IfNoneMatch)
                .await
                .unwrap()
                .unwrap();
            let before = server.current(kind).unwrap().0;
            server.store.lock().unwrap().failure = Some((suffix.into(), status, commit));
            assert!(server
                .publish(kind, snapshot("new"), &WriteCondition::IfMatch(etag))
                .await
                .is_err());
            server.assert_publications_intact();
            if suffix != REMOTE_MANIFEST || !commit {
                assert_eq!(server.current(kind).unwrap().0, before);
            }
        }
    }
}

#[tokio::test]
async fn ignored_webdav_conditions_can_lose_updates_but_not_corrupt_snapshots() {
    let server = TestServer::new(false, false).await;
    let first = snapshot("old");
    let hash = first.manifest_hash.clone();
    assert!(server
        .publish(Transport::WebDav, first, &WriteCondition::IfNoneMatch)
        .await
        .unwrap()
        .is_none());
    let remote = server.current(Transport::WebDav).unwrap();
    let condition =
        manifest_write_condition(Some(&remote), None, Some(&hash), UploadOptions::default())
            .unwrap();
    assert_eq!(condition, WriteCondition::Unconditional);
    let (a, b) = tokio::join!(
        server.publish(Transport::WebDav, snapshot("a"), &condition),
        server.publish(Transport::WebDav, snapshot("b"), &condition),
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(server.store.lock().unwrap().published.len(), 3);
    server.assert_publications_intact();
}

#[tokio::test]
async fn downloads_support_old_fixed_files_in_current_and_legacy_layouts() {
    for (kind, layout) in [
        (Transport::WebDav, RemoteLayout::Current),
        (Transport::WebDav, RemoteLayout::Legacy),
        (Transport::S3, RemoteLayout::Current),
    ] {
        let server = TestServer::new(true, true).await;
        let snap = snapshot("legacy");
        let mut manifest = snap.manifest;
        manifest.version = PROTOCOL_VERSION;
        manifest.generation = None;
        if layout == RemoteLayout::Legacy {
            manifest.db_compat_version = None;
        }
        validate_manifest_compat(&manifest, layout).unwrap();
        let prefix = TestServer::prefix(kind, layout);
        for (name, data) in [
            (REMOTE_DB_SQL, snap.db_sql),
            (REMOTE_SKILLS_ZIP, snap.skills_zip),
        ] {
            server
                .store
                .lock()
                .unwrap()
                .objects
                .insert(format!("{prefix}{name}"), (data.clone(), "\"old\"".into()));
            assert_eq!(
                server
                    .read_artifact(kind, layout, &manifest, name)
                    .await
                    .unwrap(),
                data
            );
        }
    }
}

#[tokio::test]
async fn immutable_generation_collision_is_rejected_without_overwriting() {
    for kind in [Transport::WebDav, Transport::S3] {
        let server = TestServer::new(true, true).await;
        let old = snapshot("old");
        let generation = old.manifest.generation.clone();
        let etag = server
            .publish(kind, old, &WriteCondition::IfNoneMatch)
            .await
            .unwrap()
            .unwrap();
        let before = server.current(kind).unwrap().0;
        let mut collision = snapshot("collision");
        collision.manifest.generation = generation;
        collision.manifest_bytes = serde_json::to_vec(&collision.manifest).unwrap();
        assert!(server
            .publish(kind, collision, &WriteCondition::IfMatch(etag))
            .await
            .is_err());
        assert_eq!(server.current(kind).unwrap().0, before);
        server.assert_publications_intact();
    }
}

#[tokio::test]
async fn http_get_distinguishes_existing_etagless_manifest_from_absence() {
    let server = TestServer::new(true, false).await;
    let url = format!("{}/manifest.json", server.url);
    assert!(webdav::get_bytes(&url, &None, MAX_MANIFEST_BYTES)
        .await
        .unwrap()
        .is_none());
    server.store.lock().unwrap().objects.insert(
        "/manifest.json".into(),
        (b"{}".to_vec(), "\"unused\"".into()),
    );
    assert_eq!(
        webdav::get_bytes(&url, &None, MAX_MANIFEST_BYTES)
            .await
            .unwrap(),
        Some((b"{}".to_vec(), None))
    );
    assert!(
        s3::get_object(&server.creds(), "manifest.json", MAX_MANIFEST_BYTES)
            .await
            .unwrap()
            .is_none()
    );
    server.store.lock().unwrap().objects.insert(
        "/bucket/manifest.json".into(),
        (b"{}".to_vec(), "\"unused\"".into()),
    );
    assert_eq!(
        s3::get_object(&server.creds(), "manifest.json", MAX_MANIFEST_BYTES)
            .await
            .unwrap(),
        Some((b"{}".to_vec(), None))
    );
}

#[tokio::test]
async fn force_publication_preserves_legacy_files_and_previous_generations() {
    for kind in [Transport::WebDav, Transport::S3] {
        let server = TestServer::new(true, true).await;
        let mut old = snapshot("legacy");
        old.manifest.version = PROTOCOL_VERSION;
        old.manifest.generation = None;
        let bytes = serde_json::to_vec(&old.manifest).unwrap();
        let prefix = TestServer::prefix(kind, RemoteLayout::Current);
        {
            let mut store = server.store.lock().unwrap();
            for (name, data) in [
                (REMOTE_DB_SQL, old.db_sql),
                (REMOTE_SKILLS_ZIP, old.skills_zip),
                (REMOTE_MANIFEST, bytes),
            ] {
                store
                    .objects
                    .insert(format!("{prefix}{name}"), (data, "\"legacy\"".into()));
            }
            store.published.push((prefix, old.manifest));
        }
        for label in ["first-v3", "forced-update"] {
            let remote = server.current(kind).unwrap();
            let condition =
                manifest_write_condition(Some(&remote), None, None, UploadOptions { force: true })
                    .unwrap();
            assert_eq!(condition, WriteCondition::Unconditional);
            server
                .publish(kind, snapshot(label), &condition)
                .await
                .unwrap();
        }
        assert_eq!(server.store.lock().unwrap().published.len(), 3);
        server.assert_publications_intact();
    }
}

#[tokio::test]
async fn rejected_manifest_paths_never_issue_artifact_requests() {
    for kind in [Transport::WebDav, Transport::S3] {
        let server = TestServer::new(true, true).await;
        let mut manifest = snapshot("bad-path").manifest;
        manifest.generation = Some("../outside".into());
        assert!(server
            .read_artifact(kind, RemoteLayout::Current, &manifest, REMOTE_DB_SQL)
            .await
            .is_err());
        manifest.version = MANIFEST_VERSION + 1;
        assert!(server
            .read_artifact(kind, RemoteLayout::Current, &manifest, REMOTE_DB_SQL)
            .await
            .is_err());
        assert!(server.store.lock().unwrap().requests.is_empty());
    }
}
