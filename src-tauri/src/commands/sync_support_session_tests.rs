//! Deterministic import/replacement interleavings; never use timing as evidence.

use super::{replace_database, with_stopped_proxy};
use crate::database::Database;
use crate::services::session_usage::{run_session_sync_blocking, session_sync_mutex};
use crate::services::sync_protocol::apply_snapshot;
use crate::store::AppState;
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tokio::sync::oneshot;

// All tests using this fixture are serial with the other HOME/settings tests.
struct TestHome {
    dir: tempfile::TempDir,
    previous_home: Option<std::ffi::OsString>,
    previous_settings: Option<crate::settings::AppSettings>,
}

impl TestHome {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let previous_home = std::env::var_os("CC_SWITCH_TEST_HOME");
        std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
        let mut home = Self {
            dir,
            previous_home,
            previous_settings: None,
        };
        assert!(crate::config::get_app_config_dir().starts_with(home.dir.path()));
        home.previous_settings = Some(crate::settings::get_settings());
        crate::settings::update_settings(Default::default()).unwrap();
        home
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        // Restore the cache while disk writes still target the disposable HOME.
        if let Some(settings) = self.previous_settings.take() {
            let _ = crate::settings::update_settings(settings);
        }
        match self.previous_home.take() {
            Some(home) => std::env::set_var("CC_SWITCH_TEST_HOME", home),
            None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
        }
    }
}

async fn finish<T>(future: impl std::future::Future<Output = T>) -> T {
    // A timeout bounds a broken test, but is never used to infer ordering.
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("interleaving must finish without deadlock")
}

fn local_db() -> Arc<Database> {
    let db = Arc::new(Database::memory().unwrap());
    db.conn
        .lock()
        .unwrap()
        .execute_batch(
            "INSERT INTO session_log_sync
             (file_path, last_modified, last_line_offset, last_synced_at)
             VALUES ('/test/session.jsonl', 1, 0, 0)",
        )
        .unwrap();
    db
}

fn usage_and_cursor(conn: &rusqlite::Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT (SELECT COALESCE(SUM(input_tokens), 0) FROM proxy_request_logs),
                (SELECT last_line_offset FROM session_log_sync
                 WHERE file_path = '/test/session.jsonl')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

fn commit_usage(db: &Database) {
    db.conn
        .lock()
        .unwrap()
        .execute_batch(
            "BEGIN;
             INSERT INTO proxy_request_logs
             (request_id, provider_id, app_type, model, input_tokens,
              latency_ms, status_code, created_at, data_source)
             VALUES ('session-request', 'session-import', 'codex', 'test-model',
                     42, 0, 200, 1, 'session');
             COMMIT;",
        )
        .unwrap();
}

fn advance_cursor(db: &Database) {
    db.conn
        .lock()
        .unwrap()
        .execute_batch("UPDATE session_log_sync SET last_line_offset = 1")
        .unwrap();
}

async fn paused_import(
    db: Arc<Database>,
) -> (
    tokio::task::JoinHandle<Result<(), String>>,
    mpsc::Sender<()>,
) {
    let (committed_tx, committed_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let task = tokio::spawn(run_session_sync_blocking(move || {
        commit_usage(&db);
        // The usage transaction and DB connection guard have both ended.
        committed_tx.send(()).unwrap();
        // Dropping the sender on test failure also unblocks the real worker.
        if resume_rx.recv().is_ok() {
            advance_cursor(&db);
        }
    }));
    finish(committed_rx).await.unwrap();
    (task, resume_tx)
}

#[tokio::test]
#[serial_test::serial]
async fn cloud_replacement_waits_for_usage_and_cursor_even_after_import_cancel() {
    let _home = TestHome::new();
    let remote = Database::memory().unwrap();
    remote
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "INSERT INTO settings (key, value) VALUES ('sync-test', 'remote');
             INSERT INTO providers (id, app_type, name, settings_config)
             VALUES ('remote-provider', 'codex', 'Remote', '{}');",
        )
        .unwrap();
    let sql = remote.export_sql_string_for_sync().unwrap();
    let zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()))
        .finish()
        .unwrap()
        .into_inner();

    // Both cloud transports await this same production application function.
    for cancel in [false, true] {
        let db = local_db();
        let (import, resume) = paused_import(db.clone()).await;
        let import = if cancel {
            import.abort();
            assert!(finish(import).await.unwrap_err().is_cancelled());
            None
        } else {
            Some(import)
        };
        assert_eq!(usage_and_cursor(&db.conn.lock().unwrap()), (42, 0));

        let replacement = apply_snapshot(&db, sql.as_bytes(), &zip);
        tokio::pin!(replacement);
        // Polling the real replacement proves it stops before taking a local
        // snapshot, not merely that a spawned task has yet to be scheduled.
        assert!(futures::poll!(&mut replacement).is_pending());
        assert_eq!(usage_and_cursor(&db.conn.lock().unwrap()), (42, 0));
        resume.send(()).unwrap();
        finish(replacement).await.unwrap();
        if let Some(import) = import {
            finish(import).await.unwrap().unwrap();
        }
        let conn = db.conn.lock().unwrap();
        assert_eq!(usage_and_cursor(&conn), (42, 1));
        let marker: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'sync-test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, "remote", "the replacement must actually commit");
    }
}

#[tokio::test]
#[serial_test::serial]
async fn local_replacement_holds_session_lock_for_the_entire_callback() {
    let _home = TestHome::new();
    let db = local_db();
    let state = AppState::new(db.clone());
    let (import, resume) = paused_import(db.clone()).await;
    let (verify_tx, verify_rx) = mpsc::channel();
    let replacement = tauri::async_runtime::spawn_blocking(move || {
        with_stopped_proxy(&state, || {
            replace_database(&state, || {
                let snapshot = state.db.snapshot_to_memory()?;
                // The importer has returned before checking lock ownership, so
                // its guard cannot accidentally make this assertion pass.
                if verify_rx.recv().is_err() {
                    return Err(crate::error::AppError::Message("test cancelled".into()));
                }
                assert!(session_sync_mutex().try_lock().is_err());
                assert_eq!(usage_and_cursor(&snapshot), (42, 1));
                let mut conn = state.db.conn.lock().unwrap();
                rusqlite::backup::Backup::new(&snapshot, &mut conn)?.step(-1)?;
                Ok(String::new())
            })
        })
    });
    resume.send(()).unwrap();
    finish(import).await.unwrap().unwrap();
    verify_tx.send(()).unwrap();
    finish(replacement).await.unwrap().unwrap();
    assert_eq!(usage_and_cursor(&db.conn.lock().unwrap()), (42, 1));
}

#[tokio::test]
#[serial_test::serial]
async fn importer_waits_until_local_snapshot_replacement_finishes() {
    let _home = TestHome::new();
    let db = local_db();
    let state = AppState::new(db.clone());
    let (snapshot_tx, snapshot_rx) = oneshot::channel();
    let (replace_tx, replace_rx) = mpsc::channel();
    let replacement = tauri::async_runtime::spawn_blocking(move || {
        with_stopped_proxy(&state, || {
            replace_database(&state, || {
                let snapshot = state.db.snapshot_to_memory()?;
                snapshot_tx.send(()).unwrap();
                if replace_rx.recv().is_err() {
                    return Err(crate::error::AppError::Message("test cancelled".into()));
                }
                let mut conn = state.db.conn.lock().unwrap();
                rusqlite::backup::Backup::new(&snapshot, &mut conn)?.step(-1)?;
                Ok(String::new())
            })
        })
    });
    finish(snapshot_rx).await.unwrap();

    let import_db = db.clone();
    let import = run_session_sync_blocking(move || {
        commit_usage(&import_db);
        advance_cursor(&import_db);
    });
    tokio::pin!(import);
    assert!(futures::poll!(&mut import).is_pending());
    assert_eq!(usage_and_cursor(&db.conn.lock().unwrap()), (0, 0));
    replace_tx.send(()).unwrap();
    finish(replacement).await.unwrap().unwrap();
    finish(import).await.unwrap();
    assert_eq!(usage_and_cursor(&db.conn.lock().unwrap()), (42, 1));
}
