use indexmap::IndexMap;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::prompt::Prompt;
use crate::prompt_files::prompt_file_path;
use crate::security_limits::{read_to_string_limited, MAX_CONFIG_FILE_BYTES};
use crate::store::AppState;

/// 安全地获取当前 Unix 时间戳
fn get_unix_timestamp() -> Result<i64, AppError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|e| AppError::Message(format!("Failed to get system time: {e}")))
}

pub struct PromptService;

impl PromptService {
    pub fn get_prompts(
        state: &AppState,
        app: AppType,
    ) -> Result<IndexMap<String, Prompt>, AppError> {
        state.db.get_prompts(app.as_str())
    }

    pub fn upsert_prompt(
        state: &AppState,
        app: AppType,
        _id: &str,
        prompt: Prompt,
    ) -> Result<(), AppError> {
        if prompt.template_id.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        }) {
            return Err(AppError::InvalidInput("模板来源标识无效。".into()));
        }
        if app == AppType::Codex {
            if _id != prompt.id || prompt.id.trim().is_empty() {
                return Err(AppError::InvalidInput("提示词标识不一致或为空。".into()));
            }
            if prompt.content.len() as u64 > crate::security_limits::MAX_CONFIG_FILE_BYTES {
                return Err(AppError::InvalidInput("提示词内容超过大小上限。".into()));
            }
            return update_codex_prompts(state, |prompts| {
                prompts.insert(prompt.id.clone(), prompt);
                Ok(())
            });
        }
        let _guard =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
        let before = state.db.get_prompts(app.as_str())?;
        let mut next = before.clone();
        let affects_live = prompt.enabled || before.get(&prompt.id).is_some_and(|old| old.enabled);
        if prompt.enabled {
            for saved in next.values_mut() {
                saved.enabled = false;
            }
        }
        next.insert(prompt.id.clone(), prompt);
        let mut changes = crate::config::cas::Changeset::new();
        if affects_live {
            let snapshot = crate::config::cas::FileSnapshot::read(prompt_file_path(&app)?)?;
            let content = next
                .values()
                .find(|value| value.enabled)
                .map(|value| value.content.as_str())
                .unwrap_or("");
            if snapshot.contents().is_some() || !content.is_empty() {
                changes.write(snapshot, content.as_bytes().to_vec())?;
            }
        }
        commit_non_codex_prompt_changes(state, &app, &before, &next, changes)
    }

    pub fn delete_prompt(state: &AppState, app: AppType, id: &str) -> Result<(), AppError> {
        let _guard =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
        let prompts = state.db.get_prompts(app.as_str())?;

        if let Some(prompt) = prompts.get(id) {
            if prompt.enabled {
                return Err(AppError::InvalidInput("无法删除已启用的提示词".to_string()));
            }
        }

        state.db.delete_prompt(app.as_str(), id)?;
        Ok(())
    }

    pub fn enable_prompt(state: &AppState, app: AppType, id: &str) -> Result<(), AppError> {
        if app == AppType::Codex {
            return update_codex_prompts(state, |prompts| {
                if !prompts.contains_key(id) {
                    return Err(AppError::InvalidInput("提示词不存在。".into()));
                }
                for prompt in prompts.values_mut() {
                    prompt.enabled = prompt.id == id;
                }
                Ok(())
            });
        }
        let _guard =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
        let before = state.db.get_prompts(app.as_str())?;
        if !before.contains_key(id) {
            return Err(AppError::InvalidInput(format!("提示词 {id} 不存在")));
        }
        let snapshot = crate::config::cas::FileSnapshot::read(prompt_file_path(&app)?)?;
        let live = std::str::from_utf8(snapshot.contents().unwrap_or_default())
            .map_err(|_| AppError::InvalidInput("提示词文件必须为 UTF-8。".into()))?;
        let mut next = before.clone();
        if !live.trim().is_empty() {
            if let Some(active) = next.values_mut().find(|value| value.enabled) {
                active.content = live.to_string();
                active.updated_at = Some(get_unix_timestamp()?);
            } else if !next
                .values()
                .any(|value| value.content.trim() == live.trim())
            {
                let timestamp = get_unix_timestamp()?;
                let backup_id = format!("backup-{}", uuid::Uuid::new_v4());
                next.insert(
                    backup_id.clone(),
                    Prompt {
                        id: backup_id,
                        template_id: None,
                        name: format!(
                            "原始提示词 {}",
                            chrono::Local::now().format("%Y-%m-%d %H:%M")
                        ),
                        content: live.to_string(),
                        description: Some("自动备份的原始提示词".into()),
                        enabled: false,
                        created_at: Some(timestamp),
                        updated_at: Some(timestamp),
                    },
                );
            }
        }
        for value in next.values_mut() {
            value.enabled = value.id == id;
        }
        let mut changes = crate::config::cas::Changeset::new();
        changes.write(snapshot, next[id].content.as_bytes().to_vec())?;
        commit_non_codex_prompt_changes(state, &app, &before, &next, changes)
    }

    pub fn import_from_file(state: &AppState, app: AppType) -> Result<String, AppError> {
        let file_path = prompt_file_path(&app)?;

        if !file_path.exists() {
            return Err(AppError::Message("提示词文件不存在".to_string()));
        }

        let content = read_to_string_limited(&file_path, MAX_CONFIG_FILE_BYTES)
            .map_err(|e| AppError::io(&file_path, e))?;
        let timestamp = get_unix_timestamp()?;

        let id = format!("imported-{}", uuid::Uuid::new_v4());
        let prompt = Prompt {
            template_id: None,
            id: id.clone(),
            name: format!(
                "导入的提示词 {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M")
            ),
            content,
            description: Some("从现有配置文件导入".to_string()),
            enabled: false,
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
        };

        Self::upsert_prompt(state, app, &id, prompt)?;
        Ok(id)
    }

    /// Import a user-selected Markdown file as an inactive library entry only.
    pub fn import_markdown_file(
        state: &AppState,
        app: AppType,
        path: &std::path::Path,
    ) -> Result<String, AppError> {
        if !path.is_absolute()
            || !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("md"))
        {
            return Err(AppError::InvalidInput(
                "请选择 Markdown (.md) 文件。".into(),
            ));
        }
        let content = read_to_string_limited(path, MAX_CONFIG_FILE_BYTES).map_err(|_| {
            AppError::InvalidInput(
                "无法读取 Markdown 文件：需为不超过 8 MiB 的普通 UTF-8 文件。".into(),
            )
        })?;
        if content.trim().is_empty() {
            return Err(AppError::InvalidInput("不能导入空提示词。".into()));
        }
        if app == AppType::Codex {
            // Validate with the same rules as activation; importing is not takeover.
            crate::managed_prompts::project("", Some(&content), None)?;
        }
        let timestamp = get_unix_timestamp()?;
        let id = format!("imported-{}", uuid::Uuid::new_v4());
        let prompt = Prompt {
            template_id: None,
            id: id.clone(),
            name: path
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("导入的提示词")
                .to_string(),
            content,
            description: Some("从 Markdown 文件导入；默认禁用".into()),
            enabled: false,
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
        };
        // Import persists only the library entry on whole-file clients.
        if app == AppType::Codex {
            Self::upsert_prompt(state, app, &id, prompt)?;
        } else {
            let _guard =
                futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
            state.db.save_prompt(app.as_str(), &prompt)?;
        }
        Ok(id)
    }

    /// User-confirmed migration. Renderer text is an expected-state guard only,
    /// never the source of the written body or a destination path.
    pub fn adopt_foreign_codex(
        state: &AppState,
        expected_content: &str,
    ) -> Result<String, AppError> {
        use crate::config::cas::{Changeset, FileSnapshot};
        if expected_content.len() as u64 > MAX_CONFIG_FILE_BYTES {
            return Err(AppError::InvalidInput("确认内容超过大小上限。".into()));
        }
        let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        ensure_codex_prompt_writable(state)?;
        let snapshot = FileSnapshot::read(prompt_file_path(&AppType::Codex)?)?;
        if snapshot.contents() != Some(expected_content.as_bytes()) {
            return Err(AppError::InvalidInput(
                "AGENTS.md 已变化，请刷新并重新确认接管。".into(),
            ));
        }
        let existing = std::str::from_utf8(snapshot.contents().unwrap_or_default())
            .map_err(|_| AppError::InvalidInput("AGENTS.md 必须使用 UTF-8 编码。".into()))?;
        let (content, body) = crate::managed_prompts::adopt_foreign(existing)?;
        let before = state.db.get_prompts("codex")?;
        let mut next = before.clone();
        for prompt in next.values_mut() {
            prompt.enabled = false;
        }
        let id = format!("adopted-{}", uuid::Uuid::new_v4());
        let timestamp = get_unix_timestamp()?;
        next.insert(
            id.clone(),
            Prompt {
                template_id: None,
                id: id.clone(),
                name: "从 Codex-X 接管的提示词".into(),
                content: body,
                description: Some("用户确认接管；原条目保留但禁用".into()),
                enabled: true,
                created_at: Some(timestamp),
                updated_at: Some(timestamp),
            },
        );
        super::live_backup::create_prompt_backup(&state.db, &snapshot)?;
        let mut changes = Changeset::new();
        changes.write(snapshot, content.into_bytes())?;
        commit_prompt_changes(state, &before, &next, changes)?;
        Ok(id)
    }

    pub fn get_current_file_content(app: AppType) -> Result<Option<String>, AppError> {
        let file_path = prompt_file_path(&app)?;
        if !file_path.exists() {
            return Ok(None);
        }
        let content = read_to_string_limited(&file_path, MAX_CONFIG_FILE_BYTES)
            .map_err(|e| AppError::io(&file_path, e))?;
        Ok(Some(content))
    }

    /// 首次启动时从现有提示词文件自动导入（如果存在）
    /// 返回导入的数量
    pub fn import_from_file_on_first_launch(
        state: &AppState,
        app: AppType,
    ) -> Result<usize, AppError> {
        let _guard = if app != AppType::Codex {
            Some(futures::executor::block_on(
                state.proxy_service.lock_switch_for_app(app.as_str()),
            ))
        } else {
            None
        };
        // 幂等性保护：该应用已有提示词则跳过
        let existing = state.db.get_prompts(app.as_str())?;
        if !existing.is_empty() {
            return Ok(0);
        }

        let file_path = prompt_file_path(&app)?;

        // 检查文件是否存在
        if !file_path.exists() {
            return Ok(0);
        }

        // 读取文件内容
        let content = match read_to_string_limited(&file_path, MAX_CONFIG_FILE_BYTES) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("读取提示词文件失败: {file_path:?}, 错误: {e}");
                return Ok(0);
            }
        };

        // 检查内容是否为空
        if content.trim().is_empty() {
            return Ok(0);
        }

        log::info!("发现提示词文件，自动导入: {file_path:?}");

        // 创建提示词对象
        let timestamp = get_unix_timestamp()?;
        let id = format!("auto-imported-{timestamp}");
        let prompt = Prompt {
            template_id: None,
            id: id.clone(),
            name: format!(
                "Auto-imported Prompt {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M")
            ),
            content,
            description: Some("Automatically imported on first launch".to_string()),
            enabled: true, // 首次导入时自动启用
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
        };

        // 保存到数据库
        state.db.save_prompt(app.as_str(), &prompt)?;

        log::info!("自动导入完成: {}", app.as_str());
        Ok(1)
    }
}

/// Whole-file clients use the existing per-app switch lock and file CAS rules.
/// Commit all library changes atomically; only restore our own file version on failure.
fn commit_non_codex_prompt_changes(
    state: &AppState,
    app: &AppType,
    before: &IndexMap<String, Prompt>,
    next: &IndexMap<String, Prompt>,
    changes: crate::config::cas::Changeset,
) -> Result<(), AppError> {
    assert_ne!(app, &AppType::Codex);
    let applied = changes.commit()?;
    if let Err(error) = persist_non_codex_prompts(&state.db, app.as_str(), before, next) {
        if let Err(rollback) = applied.rollback() {
            return Err(AppError::Message(format!(
                "提示词数据库提交失败: {error}; 生效文件恢复失败: {rollback}。数据库未提交，请检查生效文件后重试。"
            )));
        }
        return Err(error);
    }
    Ok(())
}

// Kept local to this service: unlike Codex this writer does not change prompt ownership.
fn persist_non_codex_prompts(
    db: &crate::database::Database,
    app: &str,
    before: &IndexMap<String, Prompt>,
    next: &IndexMap<String, Prompt>,
) -> Result<(), AppError> {
    use rusqlite::params;
    let mut conn = crate::database::lock_conn!(db.conn);
    let tx = conn
        .transaction()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let write = (|| -> Result<(), rusqlite::Error> {
        // CAS includes all fields visible to this writer, so bypassing our operation
        // lock (e.g. a concurrent import) cannot be overwritten by a stale snapshot.
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM prompts WHERE app_type = ?1",
            [app],
            |row| row.get(0),
        )?;
        if count != before.len() as i64 {
            return Err(rusqlite::Error::StatementChangedRows(0));
        }
        for old in before.values() {
            let matches: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM prompts WHERE app_type = ?1 AND id = ?2 AND name IS ?3
                 AND content IS ?4 AND description IS ?5 AND enabled IS ?6 AND created_at IS ?7
                 AND updated_at IS ?8 AND template_id IS ?9)",
                params![
                    app,
                    old.id,
                    old.name,
                    old.content,
                    old.description,
                    old.enabled,
                    old.created_at,
                    old.updated_at,
                    old.template_id
                ],
                |row| row.get(0),
            )?;
            if !matches {
                return Err(rusqlite::Error::StatementChangedRows(0));
            }
        }
        for prompt in next
            .values()
            .filter(|value| before.get(&value.id) != Some(*value))
        {
            tx.execute(
                "INSERT INTO prompts (id, app_type, name, content, description, enabled, created_at, updated_at, template_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id, app_type) DO UPDATE SET name=excluded.name, content=excluded.content,
                 description=excluded.description, enabled=excluded.enabled, created_at=excluded.created_at,
                 updated_at=excluded.updated_at, template_id=COALESCE(excluded.template_id, prompts.template_id)",
                params![prompt.id, app, prompt.name, prompt.content, prompt.description, prompt.enabled, prompt.created_at, prompt.updated_at, prompt.template_id],
            )?;
        }
        Ok(())
    })();
    write.map_err(|error| {
        AppError::Database(format!("提示词保存失败或记录已变化，请刷新后重试: {error}"))
    })?;
    tx.commit()
        .map_err(|error| AppError::Database(error.to_string()))
}

fn active_content(prompts: &IndexMap<String, Prompt>) -> Result<String, AppError> {
    let mut active: Vec<_> = prompts.values().filter(|prompt| prompt.enabled).collect();
    let total = active.iter().fold(0usize, |total, prompt| {
        total.saturating_add(prompt.content.len()).saturating_add(2)
    });
    if total as u64 > MAX_CONFIG_FILE_BYTES {
        return Err(AppError::InvalidInput(
            "生效提示词合计超过大小上限。".into(),
        ));
    }
    active.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    Ok(active
        .into_iter()
        .map(|prompt| prompt.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Plan library reconciliation under the caller's Codex switch lock. Never infer
/// ownership of unmarked or foreign text, and never overwrite saved templates.
pub(crate) fn prompts_after_restore(
    before: &IndexMap<String, Prompt>,
    bytes: &[u8],
) -> Result<IndexMap<String, Prompt>, AppError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::InvalidInput("备份中的 AGENTS.md 必须为 UTF-8。".into()))?;
    let body = crate::managed_prompts::owned_body(text)?;
    if body.is_some() {
        let current = active_content(before)?;
        if !current.trim().is_empty()
            && crate::managed_prompts::project(text, Some(&current), None)
                .is_ok_and(|projected| projected == text)
        {
            return Ok(before.clone());
        }
    }
    let mut next = before.clone();
    for prompt in next.values_mut() {
        prompt.enabled = false;
    }
    if let Some(body) = body {
        // A restored aggregate may not correspond to any surviving template.
        // Keep it explicit as a recovered entry rather than guessing old IDs.
        let id = format!("restored-{}", uuid::Uuid::new_v4());
        let timestamp = get_unix_timestamp()?;
        next.insert(
            id.clone(),
            Prompt {
                template_id: None,
                id,
                name: "从 Live 备份恢复的提示词".into(),
                content: body.to_string(),
                description: Some("恢复的 Chimera 受管区块；原模板保留且已禁用".into()),
                enabled: true,
                created_at: Some(timestamp),
                updated_at: Some(timestamp),
            },
        );
    }
    Ok(next)
}

/// The only Codex prompt projection path; kept separate from whole-file clients.
/// File work happens outside the DB mutex; the short final transaction verifies
/// observed rows, and any DB failure rolls back the file with the same CAS rules.
fn update_codex_prompts(
    state: &AppState,
    update: impl FnOnce(&mut IndexMap<String, Prompt>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    use crate::config::cas::FileSnapshot;
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
    let before = state.db.get_prompts("codex")?;
    let mut next = before.clone();
    update(&mut next)?;
    let previous_content = active_content(&before)?;
    let content = active_content(&next)?;
    if next
        .values()
        .any(|prompt| prompt.enabled && prompt.content.trim().is_empty())
    {
        return Err(AppError::InvalidInput("启用的提示词不能为空。".into()));
    }
    // Saving/importing an inactive row must never touch a hand-written file.
    if previous_content == content {
        return state.db.commit_codex_prompts(&before, &next, false);
    }
    ensure_codex_prompt_writable(state)?;
    let snapshot = FileSnapshot::read(prompt_file_path(&AppType::Codex)?)?;
    let legacy_hash = state.db.codex_legacy_prompt_hash()?;
    let body = next
        .values()
        .any(|prompt| prompt.enabled)
        .then_some(content.as_str());
    // Validate before creating a backup. The subsequent plan uses this same snapshot.
    let existing = std::str::from_utf8(snapshot.contents().unwrap_or_default())
        .map_err(|_| AppError::InvalidInput("AGENTS.md 必须使用 UTF-8 编码。".into()))?;
    crate::managed_prompts::project(existing, body, legacy_hash)?;
    super::live_backup::create_prompt_backup(&state.db, &snapshot)?;
    commit_prompt_changes(
        state,
        &before,
        &next,
        crate::managed_prompts::plan(snapshot, body, legacy_hash)?,
    )
}

fn ensure_codex_prompt_writable(state: &AppState) -> Result<(), AppError> {
    if futures::executor::block_on(state.db.get_live_backup("codex"))
        .map_err(|_| AppError::Message("无法检查代理接管状态。".into()))?
        .is_some()
        || state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&AppType::Codex)
    {
        return Err(AppError::InvalidInput(
            "请先关闭 Codex 代理接管，再修改生效提示词。".into(),
        ));
    }
    Ok(())
}

fn commit_prompt_changes(
    state: &AppState,
    before: &IndexMap<String, Prompt>,
    next: &IndexMap<String, Prompt>,
    changes: crate::config::cas::Changeset,
) -> Result<(), AppError> {
    let applied = changes.commit()?;
    if let Err(error) = state.db.commit_codex_prompts(before, next, true) {
        if applied.rollback().is_err() {
            return Err(AppError::Message(
                "提示词保存失败且文件已被外部修改，无法自动回滚；请检查 Live 备份。".into(),
            ));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod managed_tests {
    use super::*;
    use crate::database::Database;
    use crate::services::live_backup::{self, tests::TempHome};
    use serial_test::serial;
    use std::{fs, sync::Arc};

    fn prompt(id: &str, content: &str, enabled: bool) -> Prompt {
        Prompt {
            template_id: None,
            id: id.into(),
            name: id.into(),
            content: content.into(),
            description: None,
            enabled,
            created_at: Some(1),
            updated_at: Some(1),
        }
    }
    fn setup() -> (TempHome, AppState, std::path::PathBuf) {
        let home = TempHome::new();
        crate::settings::reload_settings().unwrap();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let path = prompt_file_path(&AppType::Codex).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        (home, state, path)
    }

    #[test]
    #[serial]
    fn invalid_template_metadata_does_not_write_library_or_live_file() {
        let (_home, state, path) = setup();
        for id in [
            String::new(),
            "x".repeat(129),
            "../template".into(),
            "bad\nname".into(),
        ] {
            let mut value = prompt("copy", "Rules", false);
            value.template_id = Some(id);
            assert!(PromptService::upsert_prompt(&state, AppType::Codex, "copy", value).is_err());
            assert!(state.db.get_prompts("codex").unwrap().is_empty());
            assert!(!path.exists());
        }
    }

    #[test]
    #[serial]
    fn foreign_takeover_preserves_original_rows_and_rejects_stale_confirmation() {
        let (_home, state, path) = setup();
        let source = "User  \n<!-- CODEX-X:INSTRUCTIONS:BEGIN -->\nForeign\n<!-- CODEX-X:INSTRUCTIONS:END -->\nTail";
        fs::write(&path, source).unwrap();
        state
            .db
            .save_prompt("codex", &prompt("old", "Old rules", true))
            .unwrap();
        assert!(PromptService::adopt_foreign_codex(&state, "stale").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), source);
        assert!(live_backup::list_backups(&AppType::Codex)
            .unwrap()
            .is_empty());
        let id = PromptService::adopt_foreign_codex(&state, source).unwrap();
        let rows = state.db.get_prompts("codex").unwrap();
        assert!(!rows["old"].enabled);
        assert_eq!(rows["old"].content, "Old rules");
        assert!(rows[&id].enabled);
        assert_eq!(rows[&id].content, "Foreign\n");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            source.replace("CODEX-X:", "CHIMERA:")
        );
        assert_eq!(live_backup::list_backups(&AppType::Codex).unwrap().len(), 1);
        assert!(PromptService::adopt_foreign_codex(&state, source).is_err());
        assert_eq!(state.db.get_prompts("codex").unwrap().len(), 2);
    }

    #[test]
    #[serial]
    fn foreign_takeover_database_failure_rolls_back_original_markers() {
        let (_home, state, path) = setup();
        let source =
            "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->\nForeign\n<!-- CODEX-X:INSTRUCTIONS:END -->";
        fs::write(&path, source).unwrap();
        state.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_adoption BEFORE INSERT ON prompts BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
        ).unwrap();
        assert!(PromptService::adopt_foreign_codex(&state, source).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), source);
        assert!(state.db.get_prompts("codex").unwrap().is_empty());
    }

    #[test]
    #[serial]
    fn inactive_save_preserves_user_file_and_activation_only_owns_one_block() {
        let (_home, state, path) = setup();
        let user = "User-owned rules  \n";
        fs::write(&path, user).unwrap();
        PromptService::upsert_prompt(
            &state,
            AppType::Codex,
            "a",
            prompt("a", "Managed rules", false),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), user);
        PromptService::enable_prompt(&state, AppType::Codex, "a").unwrap();
        let live = fs::read_to_string(&path).unwrap();
        assert!(live.starts_with(user));
        assert_eq!(live.matches(crate::managed_prompts::BEGIN).count(), 1);
        let backups = live_backup::list_backups(&AppType::Codex).unwrap();
        assert!(backups.iter().any(|backup| backup.reason
            == live_backup::LiveBackupReason::PrePrompt
            && backup.files == vec![path.display().to_string()]));
        PromptService::upsert_prompt(
            &state,
            AppType::Codex,
            "a",
            prompt("a", "Managed rules", false),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), user);
        assert!(!state.db.get_prompts("codex").unwrap()["a"].enabled);
    }

    #[test]
    #[serial]
    fn legacy_activation_adopts_only_a_matching_whole_file() {
        let (_home, state, path) = setup();
        state
            .db
            .save_prompt("codex", &prompt("old", "Legacy", true))
            .unwrap();
        state
            .db
            .save_prompt("codex", &prompt("new", "Replacement", false))
            .unwrap();
        fs::write(&path, "External edit").unwrap();
        assert!(PromptService::enable_prompt(&state, AppType::Codex, "new").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "External edit");
        assert!(state.db.get_prompts("codex").unwrap()["old"].enabled);
        fs::write(&path, "Legacy").unwrap();
        PromptService::enable_prompt(&state, AppType::Codex, "new").unwrap();
        let live = fs::read_to_string(&path).unwrap();
        assert!(!live.contains("Legacy"));
        assert!(live.contains("Replacement"));
        assert!(state.db.codex_legacy_prompt_hash().unwrap().is_none());
    }

    #[test]
    #[serial]
    fn database_failure_rolls_file_back_and_does_not_change_enabled_state() {
        let (_home, state, path) = setup();
        fs::write(&path, "User rules\n").unwrap();
        PromptService::upsert_prompt(&state, AppType::Codex, "a", prompt("a", "Managed", false))
            .unwrap();
        state.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_prompt BEFORE UPDATE ON prompts BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
        ).unwrap();
        assert!(PromptService::enable_prompt(&state, AppType::Codex, "a").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "User rules\n");
        assert!(!state.db.get_prompts("codex").unwrap()["a"].enabled);
    }

    #[test]
    #[serial]
    fn concurrent_library_update_is_not_overwritten() {
        let (_home, state, _path) = setup();
        let observed = state.db.get_prompts("codex").unwrap();
        state
            .db
            .save_prompt("codex", &prompt("external", "New library entry", false))
            .unwrap();
        assert!(state
            .db
            .commit_codex_prompts(&observed, &observed, false)
            .is_err());
        assert!(state
            .db
            .get_prompts("codex")
            .unwrap()
            .contains_key("external"));
    }

    #[test]
    #[serial]
    fn prompt_backup_uses_observed_bytes_not_a_later_read() {
        use base64::Engine;
        let (_home, state, path) = setup();
        fs::write(&path, "Observed bytes").unwrap();
        let snapshot = crate::config::cas::FileSnapshot::read(&path).unwrap();
        fs::write(&path, "Later external edit").unwrap();
        let backup = live_backup::create_prompt_backup(&state.db, &snapshot)
            .unwrap()
            .unwrap();
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(backup.path).unwrap()).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(record["files"][0]["contents"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, b"Observed bytes");
        assert_eq!(fs::read_to_string(path).unwrap(), "Later external edit");
    }

    #[test]
    #[serial]
    fn deletion_only_removes_disabled_entries_and_never_changes_live_file() {
        let (_home, state, path) = setup();
        fs::write(&path, "User rules").unwrap();
        PromptService::upsert_prompt(&state, AppType::Codex, "a", prompt("a", "Managed", true))
            .unwrap();
        let before = fs::read(&path).unwrap();
        assert!(PromptService::delete_prompt(&state, AppType::Codex, "a").is_err());
        // The DAO also rejects enabled rows even when callers bypass the service check.
        assert!(state.db.delete_prompt("codex", "a").is_err());
        assert!(state.db.get_prompts("codex").unwrap().contains_key("a"));
        assert_eq!(fs::read(&path).unwrap(), before);
        PromptService::upsert_prompt(&state, AppType::Codex, "b", prompt("b", "Inactive", false))
            .unwrap();
        PromptService::delete_prompt(&state, AppType::Codex, "b").unwrap();
        assert!(!state.db.get_prompts("codex").unwrap().contains_key("b"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(PromptService::delete_prompt(&state, AppType::Codex, "b").is_err());
    }

    #[test]
    #[serial]
    fn markdown_import_preserves_bytes_without_changing_live_file() {
        let (_home, state, live) = setup();
        fs::write(&live, "User-owned live content").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("rules.MD");
        let body = "# Rules\r\n  Preserve whitespace  \r\n";
        fs::write(&source, body).unwrap();
        let id = PromptService::import_markdown_file(&state, AppType::Codex, &source).unwrap();
        let prompts = state.db.get_prompts("codex").unwrap();
        assert_eq!(prompts[&id].name, "rules");
        assert_eq!(prompts[&id].content, body);
        assert!(!prompts[&id].enabled);
        assert_eq!(fs::read_to_string(live).unwrap(), "User-owned live content");
    }

    #[test]
    #[serial]
    fn markdown_import_rejects_invalid_sources_without_persisting() {
        let (_home, state, live) = setup();
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("rules.md");
        for content in [
            "   ",
            "<!-- CODEX-X:INSTRUCTIONS:BEGIN -->",
            "<!-- CHIMERA:INSTRUCTIONS:END -->",
        ] {
            fs::write(&source, content).unwrap();
            assert!(PromptService::import_markdown_file(&state, AppType::Codex, &source).is_err());
        }
        fs::write(&source, [0xff, 0xfe]).unwrap();
        assert!(PromptService::import_markdown_file(&state, AppType::Codex, &source).is_err());
        assert!(PromptService::import_markdown_file(
            &state,
            AppType::Codex,
            std::path::Path::new("relative.md")
        )
        .is_err());
        let wrong_extension = directory.path().join("rules.txt");
        fs::write(&wrong_extension, "Valid text").unwrap();
        assert!(
            PromptService::import_markdown_file(&state, AppType::Codex, &wrong_extension).is_err()
        );
        assert!(state.db.get_prompts("codex").unwrap().is_empty());
        assert!(!live.exists());
    }

    #[test]
    #[serial]
    fn markdown_import_rejects_oversized_file_without_persisting() {
        let (_home, state, live) = setup();
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("oversized.md");
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_CONFIG_FILE_BYTES + 1)
            .unwrap();
        assert!(PromptService::import_markdown_file(&state, AppType::Codex, &source).is_err());
        assert!(state.db.get_prompts("codex").unwrap().is_empty());
        assert!(!live.exists());
    }

    #[cfg(unix)]
    #[test]
    #[serial]
    fn markdown_import_rejects_symlinks_without_persisting() {
        let (_home, state, live) = setup();
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.md");
        let link = directory.path().join("link.md");
        fs::write(&source, "Content").unwrap();
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(PromptService::import_markdown_file(&state, AppType::Codex, &link).is_err());
        assert!(state.db.get_prompts("codex").unwrap().is_empty());
        assert!(!live.exists());
    }

    #[test]
    #[serial]
    fn repeated_imports_keep_distinct_disabled_entries_and_leave_live_file_unchanged() {
        let (_home, state, path) = setup();
        fs::write(&path, "First imported content").unwrap();
        let first = PromptService::import_from_file(&state, AppType::Codex).unwrap();
        fs::write(&path, "Second imported content").unwrap();
        let second = PromptService::import_from_file(&state, AppType::Codex).unwrap();
        assert_ne!(first, second);
        let prompts = state.db.get_prompts("codex").unwrap();
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[&first].content, "First imported content");
        assert_eq!(prompts[&second].content, "Second imported content");
        assert!(prompts.values().all(|prompt| !prompt.enabled));
        assert_eq!(fs::read_to_string(path).unwrap(), "Second imported content");
    }

    #[test]
    #[serial]
    fn invalid_id_and_empty_enabled_content_do_not_touch_disk_or_database() {
        let (_home, state, path) = setup();
        assert!(PromptService::upsert_prompt(
            &state,
            AppType::Codex,
            "wrong",
            prompt("a", "Managed", true)
        )
        .is_err());
        assert!(
            PromptService::upsert_prompt(&state, AppType::Codex, "a", prompt("a", "", true))
                .is_err()
        );
        assert!(!path.exists());
        assert!(state.db.get_prompts("codex").unwrap().is_empty());
    }
}

#[cfg(test)]
mod audit_a03_tests {
    use super::*;
    use crate::config::cas::{Changeset, FileSnapshot};
    use crate::database::Database;
    use crate::services::live_backup::tests::TempHome;
    use serial_test::serial;
    use std::{fs, path::PathBuf, sync::Arc};

    fn prompt(id: &str, content: &str, enabled: bool) -> Prompt {
        Prompt {
            id: id.into(),
            name: id.into(),
            content: content.into(),
            description: None,
            enabled,
            template_id: None,
            created_at: Some(1),
            updated_at: Some(1),
        }
    }

    fn setup(app: &AppType) -> (TempHome, AppState, PathBuf) {
        let home = TempHome::new();
        crate::settings::reload_settings().unwrap();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let path = prompt_file_path(app).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        (home, state, path)
    }

    #[test]
    #[serial]
    fn live_file_failure_preserves_enabled_body_and_flags() {
        for app in [AppType::Claude, AppType::Gemini] {
            let (_home, state, path) = setup(&app);
            state
                .db
                .save_prompt(app.as_str(), &prompt("old", "saved", true))
                .unwrap();
            let before = state.db.get_prompts(app.as_str()).unwrap();
            // Portable file fault, without permissions or any user configuration.
            fs::create_dir(&path).unwrap();
            for enabled in [true, false] {
                assert!(PromptService::upsert_prompt(
                    &state,
                    app.clone(),
                    "old",
                    prompt("old", "edited", enabled)
                )
                .is_err());
                assert_eq!(state.db.get_prompts(app.as_str()).unwrap(), before);
                assert!(path.is_dir());
            }
        }
    }

    #[test]
    #[serial]
    fn database_failure_rolls_back_file_and_every_enabled_flag() {
        let (_home, state, path) = setup(&AppType::Claude);
        state
            .db
            .save_prompt("claude", &prompt("old", "saved", true))
            .unwrap();
        state
            .db
            .save_prompt("claude", &prompt("new", "replacement", false))
            .unwrap();
        fs::write(&path, b"local edits\r\n").unwrap();
        let before = state.db.get_prompts("claude").unwrap();
        state.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_new BEFORE UPDATE ON prompts WHEN NEW.id = 'new' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        ).unwrap();
        assert!(PromptService::enable_prompt(&state, AppType::Claude, "new").is_err());
        assert_eq!(state.db.get_prompts("claude").unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"local edits\r\n");
        assert!(PromptService::upsert_prompt(
            &state,
            AppType::Claude,
            "new",
            prompt("new", "edited", true)
        )
        .is_err());
        assert_eq!(state.db.get_prompts("claude").unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"local edits\r\n");
    }

    #[test]
    #[serial]
    fn failed_insert_restores_missing_live_file() {
        let (_home, state, path) = setup(&AppType::Gemini);
        state.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_insert BEFORE INSERT ON prompts BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        ).unwrap();
        assert!(PromptService::upsert_prompt(
            &state,
            AppType::Gemini,
            "new",
            prompt("new", "body", true)
        )
        .is_err());
        assert!(!path.exists());
        assert!(state.db.get_prompts("gemini").unwrap().is_empty());
    }

    #[test]
    #[serial]
    fn inactive_edit_preserves_live_and_enable_backfills_local_edits() {
        let (_home, state, path) = setup(&AppType::Claude);
        state
            .db
            .save_prompt("claude", &prompt("old", "saved", true))
            .unwrap();
        fs::write(&path, "local edits").unwrap();
        PromptService::upsert_prompt(
            &state,
            AppType::Claude,
            "new",
            prompt("new", "replacement", false),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "local edits");
        PromptService::enable_prompt(&state, AppType::Claude, "new").unwrap();
        let rows = state.db.get_prompts("claude").unwrap();
        assert!(!rows["old"].enabled);
        assert_eq!(rows["old"].content, "local edits");
        assert!(rows["new"].enabled);
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        PromptService::upsert_prompt(
            &state,
            AppType::Claude,
            "new",
            prompt("new", "replacement", false),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");
        assert!(state
            .db
            .get_prompts("claude")
            .unwrap()
            .values()
            .all(|p| !p.enabled));
    }

    #[test]
    #[serial]
    fn stale_file_or_database_snapshot_cannot_overwrite_newer_edits() {
        let (_home, state, path) = setup(&AppType::Claude);
        state
            .db
            .save_prompt("claude", &prompt("old", "saved", true))
            .unwrap();
        let before = state.db.get_prompts("claude").unwrap();
        let mut next = before.clone();
        next.get_mut("old").unwrap().content = "replacement".into();
        fs::write(&path, "original").unwrap();
        let mut changes = Changeset::new();
        changes
            .write(FileSnapshot::read(&path).unwrap(), b"replacement".to_vec())
            .unwrap();
        fs::write(&path, "external edit").unwrap();
        assert!(
            commit_non_codex_prompt_changes(&state, &AppType::Claude, &before, &next, changes)
                .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
        assert_eq!(state.db.get_prompts("claude").unwrap(), before);
        let mut changes = Changeset::new();
        changes
            .write(FileSnapshot::read(&path).unwrap(), b"replacement".to_vec())
            .unwrap();
        state
            .db
            .save_prompt("claude", &prompt("old", "newer DB", true))
            .unwrap();
        assert!(
            commit_non_codex_prompt_changes(&state, &AppType::Claude, &before, &next, changes)
                .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
        assert_eq!(
            state.db.get_prompts("claude").unwrap()["old"].content,
            "newer DB"
        );
    }
}
