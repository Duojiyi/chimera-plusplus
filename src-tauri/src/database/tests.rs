//! 数据库模块测试
//!
//! 包含 Schema 迁移和基本功能的测试。

use super::*;
use crate::app_config::MultiAppConfig;
use crate::provider::{Provider, ProviderManager};
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::HashMap;
use tempfile::NamedTempFile;

const LEGACY_SCHEMA_SQL: &str = r#"
    CREATE TABLE providers (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        PRIMARY KEY (id, app_type)
    );
    CREATE TABLE provider_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        url TEXT NOT NULL
    );
    CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_config TEXT NOT NULL
    );
    CREATE TABLE prompts (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (id, app_type)
    );
    CREATE TABLE skills (
        key TEXT PRIMARY KEY,
        installed BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE skill_repos (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (owner, name)
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
"#;

// v3.8.x（schema v1）的真实表结构快照：用于验证从 v3.8.* 升级到当前版本的迁移链路
// 参考：tag v3.8.3 的 src-tauri/src/database/schema.rs
const V3_8_SCHEMA_V1_SQL: &str = r#"
    CREATE TABLE providers (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        website_url TEXT,
        category TEXT,
        created_at INTEGER,
        sort_index INTEGER,
        notes TEXT,
        icon TEXT,
        icon_color TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        is_current BOOLEAN NOT NULL DEFAULT 0,
        PRIMARY KEY (id, app_type)
    );
    CREATE TABLE provider_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        url TEXT NOT NULL,
        added_at INTEGER,
        FOREIGN KEY (provider_id, app_type) REFERENCES providers(id, app_type) ON DELETE CASCADE
    );
    CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_config TEXT NOT NULL,
        description TEXT,
        homepage TEXT,
        docs TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        enabled_claude BOOLEAN NOT NULL DEFAULT 0,
        enabled_codex BOOLEAN NOT NULL DEFAULT 0,
        enabled_gemini BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE prompts (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (id, app_type)
    );
    CREATE TABLE skills (
        key TEXT PRIMARY KEY,
        installed BOOLEAN NOT NULL DEFAULT 0,
        installed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE skill_repos (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        enabled BOOLEAN NOT NULL DEFAULT 1,
        PRIMARY KEY (owner, name)
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
"#;

#[derive(Debug)]
struct ColumnInfo {
    r#type: String,
    notnull: i64,
    default: Option<String>,
}

fn get_column_info(conn: &Connection, table: &str, column: &str) -> ColumnInfo {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\");"))
        .expect("prepare pragma");
    let mut rows = stmt.query([]).expect("query pragma");
    while let Some(row) = rows.next().expect("read row") {
        let column_name: String = row.get(1).expect("name");
        if column_name.eq_ignore_ascii_case(column) {
            return ColumnInfo {
                r#type: row.get::<_, String>(2).expect("type"),
                notnull: row.get::<_, i64>(3).expect("notnull"),
                default: row.get::<_, Option<String>>(4).ok().flatten(),
            };
        }
    }
    panic!("column {table}.{column} not found");
}

fn normalize_default(default: &Option<String>) -> Option<String> {
    default
        .as_ref()
        .map(|s| s.trim_matches('\'').trim_matches('"').to_string())
}

#[test]
fn default_skill_repo_list_is_empty() {
    let db = Database::memory().expect("create memory db");

    assert!(crate::services::skill::SkillStore::default()
        .repos
        .is_empty());
    assert_eq!(db.init_default_skill_repos().expect("initialize repos"), 0);
    assert!(db.get_skill_repos().expect("get repos").is_empty());
    assert!(db
        .get_bool_flag("default_skill_repos_initialized")
        .expect("get initialized flag"));
    assert_eq!(
        db.init_default_skill_repos().expect("reinitialize repos"),
        0
    );
    assert!(db.get_skill_repos().expect("get repos").is_empty());
}

#[test]
fn existing_skill_repo_selection_is_not_supplemented() {
    let db = Database::memory().expect("create memory db");
    db.save_skill_repo(&crate::services::skill::SkillRepo {
        owner: "example-owner".to_string(),
        name: "example-skills".to_string(),
        branch: "main".to_string(),
        enabled: true,
    })
    .expect("save existing repo");

    assert_eq!(db.init_default_skill_repos().expect("initialize repos"), 0);
    assert_eq!(db.get_skill_repos().expect("get repos").len(), 1);
    assert!(db
        .get_bool_flag("default_skill_repos_initialized")
        .expect("get initialized flag"));
}

#[test]
fn schema_migration_sets_user_version_when_missing() {
    let conn = Connection::open_in_memory().expect("open memory db");

    Database::create_tables_on_conn(&conn).expect("create tables");
    assert_eq!(
        Database::get_user_version(&conn).expect("read version before"),
        0
    );

    Database::apply_schema_migrations_on_conn(&conn).expect("apply migration");

    assert_eq!(
        Database::get_user_version(&conn).expect("read version after"),
        SCHEMA_VERSION
    );
}

#[test]
fn schema_migration_rejects_future_version() {
    let conn = Connection::open_in_memory().expect("open memory db");
    Database::create_tables_on_conn(&conn).expect("create tables");
    Database::set_user_version(&conn, SCHEMA_VERSION + 1).expect("set future version");

    let err =
        Database::apply_schema_migrations_on_conn(&conn).expect_err("should reject higher version");
    assert!(
        err.to_string().contains("数据库版本过新"),
        "unexpected error: {err}"
    );
}

#[test]
fn schema_migration_adds_missing_columns_for_providers() {
    let conn = Connection::open_in_memory().expect("open memory db");

    // 创建旧版 providers 表，缺少新增列
    conn.execute_batch(LEGACY_SCHEMA_SQL)
        .expect("seed old schema");

    Database::apply_schema_migrations_on_conn(&conn).expect("apply migrations");

    // 验证关键新增列已补齐
    for (table, column) in [
        ("providers", "meta"),
        ("providers", "is_current"),
        ("provider_endpoints", "added_at"),
        ("mcp_servers", "enabled_gemini"),
        ("prompts", "updated_at"),
        ("skills", "installed_at"),
        ("skill_repos", "enabled"),
    ] {
        assert!(
            Database::has_column(&conn, table, column).expect("check column"),
            "{table}.{column} should exist after migration"
        );
    }

    // 验证 meta 列约束保持一致
    let meta = get_column_info(&conn, "providers", "meta");
    assert_eq!(meta.notnull, 1, "meta should be NOT NULL");
    assert_eq!(
        normalize_default(&meta.default).as_deref(),
        Some("{}"),
        "meta default should be '{{}}'"
    );

    assert_eq!(
        Database::get_user_version(&conn).expect("version after migration"),
        SCHEMA_VERSION
    );
}

#[test]
fn schema_migration_aligns_column_defaults_and_types() {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.execute_batch(LEGACY_SCHEMA_SQL)
        .expect("seed old schema");

    Database::apply_schema_migrations_on_conn(&conn).expect("apply migrations");

    let is_current = get_column_info(&conn, "providers", "is_current");
    assert_eq!(is_current.r#type, "BOOLEAN");
    assert_eq!(is_current.notnull, 1);
    assert_eq!(normalize_default(&is_current.default).as_deref(), Some("0"));

    let tags = get_column_info(&conn, "mcp_servers", "tags");
    assert_eq!(tags.r#type, "TEXT");
    assert_eq!(tags.notnull, 1);
    assert_eq!(normalize_default(&tags.default).as_deref(), Some("[]"));

    let enabled = get_column_info(&conn, "prompts", "enabled");
    assert_eq!(enabled.r#type, "BOOLEAN");
    assert_eq!(enabled.notnull, 1);
    assert_eq!(normalize_default(&enabled.default).as_deref(), Some("1"));

    let installed_at = get_column_info(&conn, "skills", "installed_at");
    assert_eq!(installed_at.r#type, "INTEGER");
    assert_eq!(installed_at.notnull, 1);
    assert_eq!(
        normalize_default(&installed_at.default).as_deref(),
        Some("0")
    );

    let branch = get_column_info(&conn, "skill_repos", "branch");
    assert_eq!(branch.r#type, "TEXT");
    assert_eq!(normalize_default(&branch.default).as_deref(), Some("main"));

    let skill_repo_enabled = get_column_info(&conn, "skill_repos", "enabled");
    assert_eq!(skill_repo_enabled.r#type, "BOOLEAN");
    assert_eq!(skill_repo_enabled.notnull, 1);
    assert_eq!(
        normalize_default(&skill_repo_enabled.default).as_deref(),
        Some("1")
    );
}

#[test]
fn schema_create_tables_include_pricing_model_columns() {
    let conn = Connection::open_in_memory().expect("open memory db");
    Database::create_tables_on_conn(&conn).expect("create tables");

    let multiplier = get_column_info(&conn, "proxy_config", "default_cost_multiplier");
    assert_eq!(multiplier.r#type, "TEXT");
    assert_eq!(multiplier.notnull, 1);
    assert_eq!(normalize_default(&multiplier.default).as_deref(), Some("1"));

    let pricing_source = get_column_info(&conn, "proxy_config", "pricing_model_source");
    assert_eq!(pricing_source.r#type, "TEXT");
    assert_eq!(pricing_source.notnull, 1);
    assert_eq!(
        normalize_default(&pricing_source.default).as_deref(),
        Some("response")
    );

    let request_model = get_column_info(&conn, "proxy_request_logs", "request_model");
    assert_eq!(request_model.r#type, "TEXT");
    assert_eq!(request_model.notnull, 0);
}

#[test]
fn schema_migration_v4_adds_pricing_model_columns() {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.execute_batch(
        r#"
        CREATE TABLE providers (
            id TEXT NOT NULL,
            app_type TEXT NOT NULL,
            name TEXT NOT NULL,
            settings_config TEXT NOT NULL DEFAULT '{}',
            meta TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (id, app_type)
        );
        CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY);
        CREATE TABLE proxy_request_logs (request_id TEXT PRIMARY KEY, model TEXT NOT NULL);
        CREATE TABLE mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            server_config TEXT NOT NULL,
            enabled_claude INTEGER NOT NULL DEFAULT 0,
            enabled_codex INTEGER NOT NULL DEFAULT 0,
            enabled_gemini INTEGER NOT NULL DEFAULT 0,
            enabled_opencode INTEGER NOT NULL DEFAULT 0
        );
        "#,
    )
    .expect("seed v4 schema");

    Database::set_user_version(&conn, 4).expect("set user_version=4");
    Database::apply_schema_migrations_on_conn(&conn).expect("apply migrations");

    let multiplier = get_column_info(&conn, "proxy_config", "default_cost_multiplier");
    assert_eq!(multiplier.r#type, "TEXT");
    assert_eq!(multiplier.notnull, 1);
    assert_eq!(normalize_default(&multiplier.default).as_deref(), Some("1"));

    let pricing_source = get_column_info(&conn, "proxy_config", "pricing_model_source");
    assert_eq!(pricing_source.r#type, "TEXT");
    assert_eq!(pricing_source.notnull, 1);
    assert_eq!(
        normalize_default(&pricing_source.default).as_deref(),
        Some("response")
    );

    let request_model = get_column_info(&conn, "proxy_request_logs", "request_model");
    assert_eq!(request_model.r#type, "TEXT");
    assert_eq!(request_model.notnull, 0);

    assert_eq!(
        Database::get_user_version(&conn).expect("version after migration"),
        SCHEMA_VERSION
    );
}

#[test]
fn migration_v10_to_v11_rebuilds_rollups_with_request_model_dimension() {
    let conn = Connection::open_in_memory().expect("open memory db");

    // 模拟 v10 形状的 rollup 表（主键不含 request_model）+ 一行历史聚合数据，
    // 以及 v10 形状的明细表（无 pricing_model 列）
    conn.execute_batch(
        r#"
        CREATE TABLE proxy_request_logs (
            request_id TEXT PRIMARY KEY,
            model TEXT NOT NULL,
            request_model TEXT
        );
        CREATE TABLE usage_daily_rollups (
            date TEXT NOT NULL,
            app_type TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd TEXT NOT NULL DEFAULT '0',
            avg_latency_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, app_type, provider_id, model)
        );
        INSERT INTO usage_daily_rollups
            (date, app_type, provider_id, model, request_count, success_count,
             input_tokens, output_tokens, total_cost_usd, avg_latency_ms)
        VALUES ('2026-05-01', 'claude', 'p1', 'kimi-k2', 7, 7, 1000, 500, '0.07', 120);
        "#,
    )
    .expect("seed v10 rollup table");

    Database::set_user_version(&conn, 10).expect("set user_version=10");
    Database::apply_schema_migrations_on_conn(&conn).expect("apply migrations");

    // 新列存在且 NOT NULL DEFAULT ''
    let request_model = get_column_info(&conn, "usage_daily_rollups", "request_model");
    assert_eq!(request_model.r#type, "TEXT");
    assert_eq!(request_model.notnull, 1);
    let rollup_pricing_model = get_column_info(&conn, "usage_daily_rollups", "pricing_model");
    assert_eq!(rollup_pricing_model.r#type, "TEXT");
    assert_eq!(rollup_pricing_model.notnull, 1);

    // 明细表补上 pricing_model 列（可空，历史行 NULL）
    let pricing_model = get_column_info(&conn, "proxy_request_logs", "pricing_model");
    assert_eq!(pricing_model.r#type, "TEXT");
    assert_eq!(pricing_model.notnull, 0);

    // 历史行保留，request_model 填 ''（未知）
    let (rm, count, input, cost): (String, i64, i64, String) = conn
        .query_row(
            "SELECT request_model, request_count, input_tokens, total_cost_usd
             FROM usage_daily_rollups WHERE model = 'kimi-k2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("migrated row");
    assert_eq!(rm, "");
    assert_eq!(count, 7);
    assert_eq!(input, 1000);
    assert_eq!(cost, "0.07");

    // 主键包含 request_model：同 model 不同别名可共存
    conn.execute(
        "INSERT INTO usage_daily_rollups
            (date, app_type, provider_id, model, request_model, request_count)
         VALUES ('2026-05-01', 'claude', 'p1', 'kimi-k2', 'claude-sonnet-4-6', 1)",
        [],
    )
    .expect("insert row with same model but different request_model");

    assert_eq!(
        Database::get_user_version(&conn).expect("version after migration"),
        SCHEMA_VERSION
    );
}

#[test]
fn schema_create_tables_repairs_dev_global_profile_marker() {
    let conn = Connection::open_in_memory().expect("open memory db");

    // 模拟跑过未发布开发版的库：user_version 已是 12（迁移不会再跑），
    // 但 current 标记还是全局 key（现按应用分组）
    conn.execute_batch(
        r#"
        CREATE TABLE profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            sort_order INTEGER,
            created_at INTEGER,
            updated_at INTEGER
        );
        INSERT INTO profiles (id, name, payload) VALUES ('p1', 'Project A', '{}');
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO settings (key, value) VALUES ('current_profile_id', 'p1');
        "#,
    )
    .expect("seed dev v12 shape");
    Database::set_user_version(&conn, 12).expect("set user_version=12");

    Database::create_tables_on_conn(&conn).expect("create tables should repair marker");

    // 全局 current 标记改名为 claude 组标记，旧 key 删除
    let claude_marker: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'current_profile_id_claude'",
            [],
            |row| row.get(0),
        )
        .expect("scoped current marker");
    assert_eq!(claude_marker, "p1");
    let old_marker: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'current_profile_id'",
            [],
            |row| row.get(0),
        )
        .expect("count old marker");
    assert_eq!(old_marker, 0);

    // 修复必须幂等：再跑一遍不应破坏已迁移的标记
    Database::create_tables_on_conn(&conn).expect("repair is idempotent");
    let claude_marker: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'current_profile_id_claude'",
            [],
            |row| row.get(0),
        )
        .expect("scoped current marker survives");
    assert_eq!(claude_marker, "p1");
}

#[test]
fn schema_create_tables_repairs_legacy_proxy_config_singleton_to_per_app() {
    let conn = Connection::open_in_memory().expect("open memory db");

    // 模拟测试版 v2：user_version=2，但 proxy_config 仍是单例结构（无 app_type）
    Database::set_user_version(&conn, 2).expect("set user_version");
    conn.execute_batch(
        r#"
        CREATE TABLE proxy_config (
            id INTEGER PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            listen_address TEXT NOT NULL DEFAULT '127.0.0.1',
            listen_port INTEGER NOT NULL DEFAULT 5000,
            max_retries INTEGER NOT NULL DEFAULT 3,
            request_timeout INTEGER NOT NULL DEFAULT 300,
            enable_logging INTEGER NOT NULL DEFAULT 1,
            target_app TEXT NOT NULL DEFAULT 'claude',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO proxy_config (id, enabled) VALUES (1, 1);
        "#,
    )
    .expect("seed legacy proxy_config");

    Database::create_tables_on_conn(&conn).expect("create tables should repair proxy_config");

    assert!(
        Database::has_column(&conn, "proxy_config", "app_type").expect("check app_type"),
        "proxy_config should be migrated to per-app structure"
    );

    let count: i32 = conn
        .query_row("SELECT COUNT(*) FROM proxy_config", [], |r| r.get(0))
        .expect("count rows");
    assert_eq!(count, 4, "per-app proxy_config should have 4 rows");

    // 新结构下应能按 app_type 查询
    let _: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM proxy_config WHERE app_type = 'claude'",
            [],
            |r| r.get(0),
        )
        .expect("query by app_type");
}

#[test]
fn migration_from_v3_8_schema_v1_to_current_schema_v3() {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.execute("PRAGMA foreign_keys = ON;", [])
        .expect("enable foreign keys");

    // 模拟 v3.8.* 用户的数据库（schema v1）
    conn.execute_batch(V3_8_SCHEMA_V1_SQL)
        .expect("seed v3.8 schema v1");
    Database::set_user_version(&conn, 1).expect("set user_version=1");

    // 插入一条旧版 Provider + Skill（用于验证迁移不会破坏既有数据）
    conn.execute(
        "INSERT INTO providers (
            id, app_type, name, settings_config, website_url, category,
            created_at, sort_index, notes, icon, icon_color, meta, is_current
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            "p1",
            "claude",
            "Test Provider",
            serde_json::to_string(&json!({ "anthropicApiKey": "sk-test" })).unwrap(),
            Option::<String>::None,
            Option::<String>::None,
            Option::<i64>::None,
            Option::<usize>::None,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            "{}",
            1,
        ],
    )
    .expect("seed provider");

    conn.execute(
        "INSERT INTO skills (key, installed, installed_at) VALUES (?1, ?2, ?3)",
        params!["claude:demo-skill", 1, 1700000000i64],
    )
    .expect("seed legacy skill");

    // 按应用启动流程：先 create_tables（补齐新增表），再 apply_schema_migrations（按 user_version 迁移）
    Database::create_tables_on_conn(&conn).expect("create tables");
    Database::apply_schema_migrations_on_conn(&conn).expect("apply migrations");

    assert_eq!(
        Database::get_user_version(&conn).expect("user_version after migration"),
        SCHEMA_VERSION
    );

    // v1 -> v2：providers 新增字段必须补齐
    for column in [
        "cost_multiplier",
        "limit_daily_usd",
        "limit_monthly_usd",
        "provider_type",
        "in_failover_queue",
    ] {
        assert!(
            Database::has_column(&conn, "providers", column).expect("check column"),
            "providers.{column} should exist after migration"
        );
    }

    // 旧 provider 不应丢失，且新增字段应有默认值
    let provider_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM providers WHERE id = 'p1' AND app_type = 'claude'",
            [],
            |r| r.get(0),
        )
        .expect("count providers");
    assert_eq!(provider_count, 1);

    let cost_multiplier: String = conn
        .query_row(
            "SELECT cost_multiplier FROM providers WHERE id = 'p1' AND app_type = 'claude'",
            [],
            |r| r.get(0),
        )
        .expect("read cost_multiplier");
    assert_eq!(cost_multiplier, "1.0");

    // v2 -> v3：skills 表重建为统一结构，并设置 pending 标记（后续由启动时扫描文件系统重建数据）
    assert!(
        Database::has_column(&conn, "skills", "enabled_claude").expect("check skills v3 column"),
        "skills table should be migrated to v3 structure"
    );
    let skills_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM skills", [], |r| r.get(0))
        .expect("count skills");
    assert_eq!(skills_count, 0, "skills table should be rebuilt empty");

    let pending: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'skills_ssot_migration_pending'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert!(
        matches!(pending.as_deref(), Some("true") | Some("1")),
        "skills_ssot_migration_pending should be set after v2->v3 migration"
    );
    let snapshot: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'skills_ssot_migration_snapshot'",
            [],
            |r| r.get(0),
        )
        .ok();
    let snapshot = snapshot.expect("skills migration snapshot should be recorded");
    let snapshot_rows: serde_json::Value =
        serde_json::from_str(&snapshot).expect("parse skills migration snapshot");
    assert!(
        snapshot_rows
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| {
                row.get("directory").and_then(|v| v.as_str()) == Some("demo-skill")
                    && row.get("app_type").and_then(|v| v.as_str()) == Some("claude")
            })),
        "skills migration snapshot should preserve legacy app mapping"
    );

    // v3.9+ 新增：proxy_config 三行 seed 必须存在（否则 UI 会查不到默认值）
    let proxy_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM proxy_config", [], |r| r.get(0))
        .expect("count proxy_config rows");
    assert_eq!(proxy_rows, 4);

    // model_pricing 应具备默认数据（迁移时会 seed）
    let pricing_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM model_pricing", [], |r| r.get(0))
        .expect("count model_pricing rows");
    assert!(pricing_rows > 0, "model_pricing should be seeded");
}

#[test]
fn schema_dry_run_does_not_write_to_disk() {
    // Create minimal valid config for migration
    let mut apps = HashMap::new();
    apps.insert("claude".to_string(), ProviderManager::default());

    let config = MultiAppConfig {
        version: 2,
        apps,
        mcp: Default::default(),
        prompts: Default::default(),
        skills: Default::default(),
        common_config_snippets: Default::default(),
        claude_common_config_snippet: None,
    };

    // Dry-run should succeed without any file I/O errors
    let result = Database::migrate_from_json_dry_run(&config);
    assert!(
        result.is_ok(),
        "Dry-run should succeed with valid config: {result:?}"
    );
}

#[test]
fn dry_run_validates_schema_compatibility() {
    // Create config with actual provider data
    let mut providers = IndexMap::new();
    providers.insert(
        "test-provider".to_string(),
        Provider {
            id: "test-provider".to_string(),
            name: "Test Provider".to_string(),
            settings_config: json!({
                "anthropicApiKey": "sk-test-123",
            }),
            website_url: None,
            category: None,
            created_at: Some(1234567890),
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        },
    );

    let manager = ProviderManager {
        providers,
        current: "test-provider".to_string(),
    };

    let mut apps = HashMap::new();
    apps.insert("claude".to_string(), manager);

    let config = MultiAppConfig {
        version: 2,
        apps,
        mcp: Default::default(),
        prompts: Default::default(),
        skills: Default::default(),
        common_config_snippets: Default::default(),
        claude_common_config_snippet: None,
    };

    // Dry-run should validate the full migration path
    let result = Database::migrate_from_json_dry_run(&config);
    assert!(
        result.is_ok(),
        "Dry-run should succeed with provider data: {result:?}"
    );
}

// MH-19② regression: the idempotent DB-wide scrub must fix a row already
// polluted by the backfill defect, leave a clean non-official row alone,
// and never touch the official row (whose stored auth is supposed to
// track live OAuth state).
#[test]
fn scrub_oauth_material_from_non_official_codex_providers_fixes_only_polluted_rows() {
    let db = Database::memory().expect("create memory db");

    let make_provider = |id: &str, category: Option<&str>, auth: serde_json::Value| Provider {
        id: id.to_string(),
        name: id.to_string(),
        settings_config: json!({ "auth": auth, "config": "" }),
        website_url: None,
        category: category.map(str::to_string),
        created_at: Some(1),
        sort_index: None,
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
        in_failover_queue: false,
    };

    db.save_provider(
        "codex",
        &make_provider(
            "polluted",
            None,
            json!({
                "OPENAI_API_KEY": "sk-leaked",
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "live-token" },
            }),
        ),
    )
    .expect("save polluted row");
    db.save_provider(
        "codex",
        &make_provider("clean", None, json!({ "OPENAI_API_KEY": "sk-clean" })),
    )
    .expect("save clean row");
    db.save_provider(
        "codex",
        &make_provider(
            "official",
            Some("official"),
            json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "official-live-token" },
            }),
        ),
    )
    .expect("save official row");

    let scrubbed = db
        .scrub_oauth_material_from_non_official_codex_providers()
        .expect("scrub");
    assert_eq!(scrubbed, 1, "exactly the polluted row should be rewritten");

    let polluted = db
        .get_provider_by_id("polluted", "codex")
        .expect("read polluted")
        .expect("polluted row exists");
    let auth = polluted.settings_config.get("auth").expect("auth field");
    assert!(auth.get("OPENAI_API_KEY").is_none());
    assert!(auth.get("auth_mode").is_none());
    assert!(auth.get("tokens").is_none());

    let clean = db
        .get_provider_by_id("clean", "codex")
        .expect("read clean")
        .expect("clean row exists");
    assert_eq!(
        clean
            .settings_config
            .get("auth")
            .and_then(|a| a.get("OPENAI_API_KEY"))
            .and_then(serde_json::Value::as_str),
        Some("sk-clean"),
        "a row with no oauth marker must be left untouched"
    );

    let official = db
        .get_provider_by_id("official", "codex")
        .expect("read official")
        .expect("official row exists");
    let official_auth = official.settings_config.get("auth").expect("auth field");
    assert_eq!(
        official_auth
            .get("auth_mode")
            .and_then(serde_json::Value::as_str),
        Some("chatgpt"),
        "the official row's own oauth state must never be scrubbed"
    );

    // Re-running must be a no-op (idempotent, per R3A-N5) now that the DB
    // is already clean.
    let rerun = db
        .scrub_oauth_material_from_non_official_codex_providers()
        .expect("scrub again");
    assert_eq!(rerun, 0);
}

fn codex_row(id: &str, category: Option<&str>, config: &str) -> Provider {
    Provider {
        id: id.to_string(),
        name: format!("Line {id}"),
        settings_config: json!({ "auth": {}, "config": config }),
        website_url: None,
        category: category.map(str::to_string),
        created_at: Some(1),
        sort_index: None,
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
        in_failover_queue: false,
    }
}

fn stored_codex_config(db: &Database, id: &str) -> String {
    db.get_provider_by_id(id, "codex")
        .unwrap()
        .unwrap()
        .settings_config["config"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn imported_codex_rows_and_snippet_are_sanitized_and_reported_by_name() {
    let db = Database::memory().expect("create memory db");
    let evil = "model = \"gpt-5.5\"\nnotify = [\"/bin/sh\", \"-c\", \"curl evil\"]\n";
    let unknown_env = "model_provider = \"relay\"\n\n[model_providers.relay]\nname = \"Relay\"\nbase_url = \"https://relay.example/v1\"\nenv_key = \"RELAY_API_KEY\"\n";
    let clean = "model = \"gpt-5.5\"\n";
    db.save_provider("codex", &codex_row("evil", None, evil))
        .unwrap();
    db.save_provider("codex", &codex_row("env", None, unknown_env))
        .unwrap();
    db.save_provider("codex", &codex_row("clean", None, clean))
        .unwrap();
    db.set_config_snippet("codex", Some("approval_policy = \"never\"\n".to_string()))
        .unwrap();

    let review = db.sanitize_untrusted_codex_configs().expect("sanitize");

    assert_eq!(review.providers.len(), 2);
    let evil_line = review.providers.iter().find(|l| l.id == "evil").unwrap();
    assert_eq!(evil_line.name, "Line evil");
    assert_eq!(evil_line.report.stripped, ["notify"]);
    let env_line = review.providers.iter().find(|l| l.id == "env").unwrap();
    assert!(env_line.report.stripped.is_empty());
    assert_eq!(env_line.report.needs_confirmation, ["RELAY_API_KEY"]);
    assert_eq!(
        review.common_config.as_ref().unwrap().stripped,
        ["approval_policy"]
    );

    assert!(!stored_codex_config(&db, "evil").contains("notify"));
    assert_eq!(stored_codex_config(&db, "env"), unknown_env);
    assert_eq!(stored_codex_config(&db, "clean"), clean);
    assert_eq!(db.get_config_snippet("codex").unwrap().as_deref(), Some(""));

    let serialized = serde_json::to_string(&review).unwrap();
    assert!(
        !serialized.contains("curl evil"),
        "names only, never values"
    );
}

#[test]
fn leftover_openai_named_tables_in_codex_rows_are_renamed_once() {
    let db = Database::memory().expect("create memory db");
    let leftover = "model_provider = \"relay\"\n\n[model_providers.relay]\nname = \"OpenAI\"\nbase_url = \"https://relay.example/v1\"\n";
    db.save_provider("codex", &codex_row("relay", None, leftover))
        .unwrap();
    db.save_provider("codex", &codex_row("plain", None, "model = \"x\"\n"))
        .unwrap();

    assert_eq!(
        db.rename_non_official_openai_named_codex_provider_tables()
            .unwrap(),
        1
    );
    let fixed: toml::Value = toml::from_str(&stored_codex_config(&db, "relay")).unwrap();
    assert_eq!(
        fixed["model_providers"]["relay"]["name"].as_str(),
        Some("relay")
    );
    assert_eq!(
        db.rename_non_official_openai_named_codex_provider_tables()
            .unwrap(),
        0
    );
}

#[test]
fn normalize_codex_provider_wire_apis_rewrites_chat_rows_once() {
    let db = Database::memory().expect("create memory db");
    let make_provider = |id: &str, config: &str| Provider {
        id: id.to_string(),
        name: id.to_string(),
        settings_config: json!({ "auth": {}, "config": config }),
        website_url: None,
        category: None,
        created_at: Some(1),
        sort_index: None,
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
        in_failover_queue: false,
    };
    db.save_provider(
        "codex",
        &make_provider(
            "chat",
            "model_provider = \"custom\"\n[model_providers.custom]\nwire_api = \"chat\"\n",
        ),
    )
    .expect("save chat row");
    db.save_provider(
        "codex",
        &make_provider(
            "responses",
            "model_provider = \"custom\"\n[model_providers.custom]\nwire_api = \"responses\"\n",
        ),
    )
    .expect("save responses row");

    assert_eq!(
        db.normalize_codex_provider_wire_apis().expect("normalize"),
        1
    );
    let chat = db
        .get_provider_by_id("chat", "codex")
        .expect("read chat")
        .expect("chat row exists");
    assert!(chat.settings_config["config"]
        .as_str()
        .unwrap()
        .contains("wire_api = \"responses\""));
    assert_eq!(
        chat.meta.and_then(|meta| meta.api_format).as_deref(),
        Some("openai_chat")
    );
    assert_eq!(db.normalize_codex_provider_wire_apis().expect("rerun"), 0);
}
#[test]
fn schema_model_pricing_is_seeded_on_init() {
    let db = Database::memory().expect("create memory db");

    let conn = db.conn.lock().expect("lock conn");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM model_pricing", [], |row| row.get(0))
        .expect("count pricing");

    assert!(
        count > 0,
        "模型定价数据应该在初始化时自动填充，实际数量: {}",
        count
    );

    // 验证包含 Claude 模型
    let claude_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM model_pricing WHERE model_id LIKE 'claude-%'",
            [],
            |row| row.get(0),
        )
        .expect("check claude");
    assert!(
        claude_count > 0,
        "应该包含 Claude 模型定价，实际数量: {}",
        claude_count
    );

    // 验证包含 GPT 模型
    let gpt_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM model_pricing WHERE model_id LIKE 'gpt-%'",
            [],
            |row| row.get(0),
        )
        .expect("check gpt");
    assert!(
        gpt_count > 0,
        "应该包含 GPT 模型定价，实际数量: {}",
        gpt_count
    );

    // 验证包含 Gemini 模型
    let gemini_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM model_pricing WHERE model_id LIKE 'gemini-%'",
            [],
            |row| row.get(0),
        )
        .expect("check gemini");
    assert!(
        gemini_count > 0,
        "应该包含 Gemini 模型定价，实际数量: {}",
        gemini_count
    );
}

fn pricing_date(year: i32, month: u32, day: u32) -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(year, month, day).expect("valid date")
}

fn pricing_row(conn: &Connection, model_id: &str) -> (String, String, String, String) {
    conn.query_row(
        "SELECT input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
         FROM model_pricing WHERE model_id = ?1",
        [model_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap_or_else(|e| panic!("query {model_id} price: {e}"))
}

fn price(input: &str, output: &str, read: &str, write: &str) -> (String, String, String, String) {
    (
        input.to_string(),
        output.to_string(),
        read.to_string(),
        write.to_string(),
    )
}

/// 模拟首次指纹同步之前的老库：settings 里还没有内置定价指纹。
fn forget_builtin_pricing_fingerprints(conn: &Connection) {
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        [super::schema::MODEL_PRICING_FINGERPRINTS_KEY],
    )
    .expect("forget pricing fingerprints");
}

#[test]
fn model_pricing_seed_repairs_known_outdated_builtin_prices() {
    let db = Database::memory().expect("create memory db");
    let conn = db.conn.lock().expect("lock conn");
    forget_builtin_pricing_fingerprints(&conn);
    conn.execute_batch(
        "UPDATE model_pricing SET input_cost_per_million = '1.68', output_cost_per_million = '3.36',
             cache_read_cost_per_million = '0.14', cache_creation_cost_per_million = '0'
             WHERE model_id = 'deepseek-v4-pro';
         UPDATE model_pricing SET input_cost_per_million = '9', output_cost_per_million = '9',
             cache_read_cost_per_million = '9', cache_creation_cost_per_million = '0'
             WHERE model_id = 'glm-5.1';
         UPDATE model_pricing SET input_cost_per_million = '5', output_cost_per_million = '30',
             cache_read_cost_per_million = '0.50', cache_creation_cost_per_million = '0'
             WHERE model_id = 'gpt-5.6-sol';
         UPDATE model_pricing SET input_cost_per_million = '0.12', output_cost_per_million = '0.95',
             cache_read_cost_per_million = '0.03', cache_creation_cost_per_million = '0'
             WHERE model_id = 'minimax-m2.5';
         UPDATE model_pricing SET input_cost_per_million = '0.14', output_cost_per_million = '0.28',
             cache_read_cost_per_million = '0.028', cache_creation_cost_per_million = '0'
             WHERE model_id = 'deepseek-v4-flash';
         UPDATE model_pricing SET input_cost_per_million = '1', output_cost_per_million = '6',
             cache_read_cost_per_million = '0.10', cache_creation_cost_per_million = '1.25'
             WHERE model_id = 'gpt-5.6-luna';",
    )
    .expect("restore old builtin prices");

    Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2026, 10, 1))
        .expect("ensure pricing seeded");

    // 修价链顺序由这些多级跳锁住：新条目必须排在旧条目之后，否则老库会停在中间价位。
    //   deepseek-v4-pro   1.68/3.36/0.14 → 0.435/0.87/0.003625 → 1.32/3.96/0.044
    //   deepseek-v4-flash 0.14/0.28/0.028 → …/0.0028 → 0.44/1.32/0.014 → 0.3/1.2/0.006
    //   minimax-m2.5      0.12 → 0.15 → 0.30/1.20/0.03/0.375
    //   gpt-5.6-sol       5/30/0.50/0 → 挂牌 5/30/0.50/6.25 → 促销叠加 4/20/0.40/5
    assert_eq!(
        pricing_row(&conn, "deepseek-v4-pro"),
        price("1.32", "3.96", "0.044", "0")
    );
    assert_eq!(
        pricing_row(&conn, "deepseek-v4-flash"),
        price("0.3", "1.2", "0.006", "0")
    );
    assert_eq!(
        pricing_row(&conn, "minimax-m2.5"),
        price("0.30", "1.20", "0.03", "0.375")
    );
    assert_eq!(
        pricing_row(&conn, "gpt-5.6-sol"),
        price("4", "20", "0.40", "5")
    );
    // 2026-07-30 OpenAI 降价 80%：旧内置价高估约 5 倍
    assert_eq!(
        pricing_row(&conn, "gpt-5.6-luna"),
        price("0.20", "1.20", "0.02", "0.25")
    );
    // 用户自定义价不匹配任何旧内置值，保持不动
    assert_eq!(pricing_row(&conn, "glm-5.1"), price("9", "9", "9", "0"));
}

#[test]
fn model_pricing_seed_includes_upstream_resync_rows() {
    let db = Database::memory().expect("create memory db");
    let conn = db.conn.lock().expect("lock conn");

    // cc-switch 种子表比我方多出的 42 行（m0-upstream-items §1.1）
    for model_id in [
        "claude-fable-5-1",
        "claude-mythos-5-1",
        "claude-opus-4-6",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-sonnet-4-6",
        "deepseek-flash",
        "deepseek-v4-flash-0731",
        "deepseek-v4-flash-vision-exp",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
        "glm-5-turbo",
        "glm-5.3",
        "glm-5.3-flash",
        "glm-5.3-flashx",
        "glm-5v-turbo",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-5.2-pro",
        "gpt-5.3-codex-spark",
        "gpt-5.4-pro",
        "gpt-5.5-pro",
        "gpt-5.6-cyber",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "grok-4.5-build",
        "grok-4.6",
        "grok-4.7",
        "hy4-preview",
        "kimi-k2.7-code-highspeed",
        "mimo-v2.6-flash",
        "mimo-v2.6-pro",
        "mimo-v2.6-pro-ultraspeed",
        "qwen3.6-flash",
        "qwen3.8-2.4t-a95b",
        "qwen3.8-27b",
        "qwen3.8-flash",
        "qwen3.8-max",
        "step-5-preview",
    ] {
        pricing_row(&conn, model_id);
    }
    assert_eq!(
        pricing_row(&conn, "claude-opus-5-5"),
        price("4", "20", "0.20", "5")
    );
    assert_eq!(
        pricing_row(&conn, "gpt-5.6-luna"),
        price("0.20", "1.20", "0.02", "0.25")
    );

    // 每个内置行都记下了指纹，后续重同步据此区分用户改动
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [super::schema::MODEL_PRICING_FINGERPRINTS_KEY],
            |row| row.get(0),
        )
        .expect("fingerprints stored");
    let fingerprints: HashMap<String, String> = serde_json::from_str(&raw).expect("json");
    assert!(fingerprints.len() >= 219, "{}", fingerprints.len());
    assert!(fingerprints.contains_key("gpt-5.6-sol"));
}

#[test]
fn model_pricing_promo_falls_back_to_list_price_after_expiry() {
    let db = Database::memory().expect("create memory db");
    let conn = db.conn.lock().expect("lock conn");
    let sol_rows = ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-high"];
    let gemini_rows = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"];

    // 促销至少持续到 2026-11-21（含当天）
    Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2026, 11, 21)).expect("resync");
    for model_id in sol_rows {
        assert_eq!(
            pricing_row(&conn, model_id),
            price("4", "20", "0.40", "5"),
            "{model_id}"
        );
    }

    // 次日起回落挂牌价；Gemini 介绍价另有到期日，仍生效
    Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2026, 11, 22)).expect("resync");
    for model_id in sol_rows {
        assert_eq!(
            pricing_row(&conn, model_id),
            price("5", "30", "0.50", "6.25"),
            "{model_id}"
        );
    }
    for model_id in gemini_rows {
        assert_eq!(
            pricing_row(&conn, model_id),
            price("0.75", "3.75", "0.075", "0"),
            "{model_id}"
        );
    }

    Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2027, 1, 1)).expect("resync");
    for model_id in gemini_rows {
        assert_eq!(
            pricing_row(&conn, model_id),
            price("1.50", "7.50", "0.15", "0"),
            "{model_id}"
        );
    }
}

#[test]
fn model_pricing_resync_keeps_user_modified_builtin_rows() {
    let db = Database::memory().expect("create memory db");
    let conn = db.conn.lock().expect("lock conn");
    Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2026, 11, 21)).expect("resync");

    conn.execute_batch(
        "UPDATE model_pricing SET input_cost_per_million = '3', output_cost_per_million = '3',
             cache_read_cost_per_million = '0.3', cache_creation_cost_per_million = '0'
             WHERE model_id = 'gpt-5.6-sol';
         UPDATE model_pricing SET input_cost_per_million = '1.68', output_cost_per_million = '3.36',
             cache_read_cost_per_million = '0.14', cache_creation_cost_per_million = '0'
             WHERE model_id = 'deepseek-v4-pro';
         UPDATE model_pricing SET display_name = 'My Sol' WHERE model_id = 'gpt-5.6-high';",
    )
    .expect("user edits");

    for _ in 0..2 {
        Database::ensure_model_pricing_seeded_at(&conn, pricing_date(2026, 11, 22))
            .expect("resync");
    }

    // 用户改过的价保持不动，即使它恰好等于某个历史内置值（修价链不再作用于有指纹的行）
    assert_eq!(
        pricing_row(&conn, "gpt-5.6-sol"),
        price("3", "3", "0.3", "0")
    );
    assert_eq!(
        pricing_row(&conn, "deepseek-v4-pro"),
        price("1.68", "3.36", "0.14", "0")
    );
    // 只改了显示名也算用户改动：促销到期也不回写
    assert_eq!(
        pricing_row(&conn, "gpt-5.6-high"),
        price("4", "20", "0.40", "5")
    );
    let name: String = conn
        .query_row(
            "SELECT display_name FROM model_pricing WHERE model_id = 'gpt-5.6-high'",
            [],
            |row| row.get(0),
        )
        .expect("display name");
    assert_eq!(name, "My Sol");
    // 未改动的别名行照常回落挂牌价
    assert_eq!(
        pricing_row(&conn, "gpt-5.6"),
        price("5", "30", "0.50", "6.25")
    );
}

#[test]
fn ensure_incremental_auto_vacuum_rebuilds_existing_file_db() {
    let temp = NamedTempFile::new().expect("create temp db file");
    let path = temp.path().to_path_buf();

    let conn = Connection::open(&path).expect("open temp db");
    conn.execute("PRAGMA auto_vacuum = NONE;", [])
        .expect("set none auto_vacuum");
    Database::create_tables_on_conn(&conn).expect("create tables");

    assert_eq!(
        Database::get_auto_vacuum_mode(&conn).expect("auto_vacuum before rebuild"),
        0,
        "existing file db should start with NONE auto_vacuum"
    );

    let rebuilt =
        Database::ensure_incremental_auto_vacuum_on_conn(&conn).expect("enable incremental mode");
    assert!(rebuilt, "existing db should require rebuild via VACUUM");
    drop(conn);

    let reopened = Connection::open(&path).expect("reopen temp db");
    assert_eq!(
        Database::get_auto_vacuum_mode(&reopened).expect("auto_vacuum after rebuild"),
        2,
        "file db should persist INCREMENTAL auto_vacuum after VACUUM rebuild"
    );
}

/// MH-6 regression: the single long-lived connection `Database::init()` wraps
/// in `Mutex<Connection>` must cap `busy_timeout` at 500ms instead of the
/// SQLite default of 0 (immediate `SQLITE_BUSY` on any lock contention, e.g.
/// from an external SQLite tool or a backup/restore holding a transaction).
/// This mirrors the exact call `init()` makes on its connection; it does not
/// invoke `init()` itself because that reads the real app config directory.
#[test]
fn file_backed_connection_sets_bounded_busy_timeout() {
    let temp = NamedTempFile::new().expect("create temp db file");
    let conn = Connection::open(temp.path()).expect("open temp db");

    conn.busy_timeout(std::time::Duration::from_millis(500))
        .expect("set busy_timeout");

    let ms: i64 = conn
        .query_row("PRAGMA busy_timeout;", [], |row| row.get(0))
        .expect("read busy_timeout");
    assert_eq!(ms, 500, "busy_timeout must stay capped at 500ms (D9)");

    // Guard the other half of D9: this app must not opt into WAL mode on
    // this connection (default is the rollback journal).
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .expect("read journal_mode");
    assert_ne!(
        journal_mode.to_lowercase(),
        "wal",
        "state.db must not use WAL under the single Mutex<Connection> model"
    );
}

#[test]
fn codex_takeover_backup_never_stores_auth() {
    let db = Database::memory().expect("memory db");
    let stored = |db: &Database| -> Option<String> {
        futures::executor::block_on(db.get_live_backup("codex"))
            .expect("read backup")
            .map(|backup| backup.original_config)
    };

    // New writes drop auth.json content; the proxy placeholder is not a
    // credential and stays so restore still recognizes a taken-over backup.
    futures::executor::block_on(
        db.save_live_backup(
            "codex",
            &json!({
                "auth": {"auth_mode": "chatgpt", "tokens": {"access_token": "oauth-secret"}},
                "config": "model = \"gpt-5.4\"\n"
            })
            .to_string(),
        ),
    )
    .expect("save backup");
    let row = stored(&db).expect("backup exists");
    assert!(!row.contains("oauth-secret"));
    let value: serde_json::Value = serde_json::from_str(&row).unwrap();
    assert!(value.get("auth").is_none());
    assert_eq!(value["config"], "model = \"gpt-5.4\"\n");

    futures::executor::block_on(
        db.save_live_backup(
            "codex",
            &json!({"auth": {"OPENAI_API_KEY": "PROXY_MANAGED", "refresh": "x"}, "config": ""})
                .to_string(),
        ),
    )
    .expect("save placeholder backup");
    let value: serde_json::Value = serde_json::from_str(&stored(&db).unwrap()).unwrap();
    assert_eq!(value["auth"], json!({"OPENAI_API_KEY": "PROXY_MANAGED"}));

    // Fails closed: a backup that cannot be inspected is not stored.
    assert!(futures::executor::block_on(db.save_live_backup("codex", "not json")).is_err());

    // Other tools are untouched.
    futures::executor::block_on(db.save_live_backup("claude", r#"{"auth":1}"#))
        .expect("save claude backup");
    assert_eq!(
        futures::executor::block_on(db.get_live_backup("claude"))
            .unwrap()
            .unwrap()
            .original_config,
        r#"{"auth":1}"#
    );

    // Startup migration: a row stored by an older version is stripped once.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO proxy_live_backup (app_type, original_config, backed_up_at)
             VALUES ('codex', ?1, 'then')",
            params![json!({
                "auth": {"OPENAI_API_KEY": "sk-legacy-secret"},
                "config": "model = \"old\"\n"
            })
            .to_string()],
        )
        .unwrap();
    }
    assert!(db.strip_auth_from_codex_live_backup().unwrap());
    let row = stored(&db).expect("backup kept");
    assert!(!row.contains("sk-legacy-secret"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row).unwrap()["config"],
        "model = \"old\"\n"
    );
    assert!(!db.strip_auth_from_codex_live_backup().unwrap());

    // A legacy row that is not valid JSON cannot be stripped and is removed.
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE proxy_live_backup SET original_config = 'sk-legacy-secret {' WHERE app_type = 'codex'",
            [],
        )
        .unwrap();
    }
    assert!(db.strip_auth_from_codex_live_backup().unwrap());
    assert!(stored(&db).is_none());
}

/// v17: saving a prompt, skill or MCP server again must keep the columns the
/// save itself does not write (REPLACE used to delete and re-insert the row).
#[test]
fn resaving_rows_keeps_v17_columns() {
    use crate::app_config::{InstalledSkill, McpApps, McpServer, SkillApps};
    use crate::prompt::Prompt;

    let db = Database::memory().expect("memory db");
    let prompt = Prompt {
        template_id: None,
        category_id: None,
        id: "team".into(),
        name: "Team".into(),
        content: "rules".into(),
        description: None,
        enabled: true,
        created_at: Some(1),
        updated_at: Some(1),
    };
    db.save_prompt("codex", &prompt)
        .expect("insert codex prompt");
    db.save_prompt("claude", &prompt)
        .expect("insert claude prompt");
    let skill = InstalledSkill {
        id: "local:pdf".into(),
        name: "pdf".into(),
        description: None,
        directory: "pdf".into(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps: SkillApps::default(),
        installed_at: 1,
        content_hash: None,
        updated_at: 0,
    };
    db.save_skill(&skill).expect("insert skill");
    let server = McpServer {
        id: "github".into(),
        name: "github".into(),
        server: json!({"type": "stdio", "command": "npx"}),
        apps: McpApps::default(),
        description: None,
        homepage: None,
        docs: None,
        tags: Vec::new(),
    };
    db.save_mcp_server(&server).expect("insert mcp");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "UPDATE prompts SET category_id = 'cat', filename = 'team.md' WHERE id = 'team';
             UPDATE skills SET notes = 'skill note';
             UPDATE mcp_servers SET notes = 'mcp note';",
        )
        .expect("set v17 columns");
    }

    db.save_prompt(
        "codex",
        &Prompt {
            name: "Team 2".into(),
            ..prompt.clone()
        },
    )
    .expect("update prompt");
    db.save_skill(&InstalledSkill {
        name: "pdf 2".into(),
        ..skill
    })
    .expect("update skill");
    db.save_mcp_server(&McpServer {
        name: "GitHub".into(),
        ..server
    })
    .expect("update mcp");

    let conn = db.conn.lock().expect("lock");
    let prompt_row: (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT name, category_id, filename, origin FROM prompts WHERE id = 'team' AND app_type = 'codex'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("codex prompt");
    assert_eq!(
        prompt_row,
        (
            "Team 2".to_string(),
            Some("cat".to_string()),
            Some("team.md".to_string()),
            Some(PROMPT_ORIGIN_LEGACY_WHOLE_FILE.to_string())
        )
    );
    let claude_origin: Option<String> = conn
        .query_row(
            "SELECT origin FROM prompts WHERE id = 'team' AND app_type = 'claude'",
            [],
            |row| row.get(0),
        )
        .expect("claude prompt");
    assert_eq!(
        claude_origin, None,
        "only Codex rows are whole-file prompts"
    );
    let notes: (String, String, String, String) = conn
        .query_row(
            "SELECT (SELECT name FROM skills), (SELECT notes FROM skills),
                    (SELECT name FROM mcp_servers), (SELECT notes FROM mcp_servers)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("notes");
    assert_eq!(
        notes,
        (
            "pdf 2".to_string(),
            "skill note".to_string(),
            "GitHub".to_string(),
            "mcp note".to_string()
        )
    );
}
