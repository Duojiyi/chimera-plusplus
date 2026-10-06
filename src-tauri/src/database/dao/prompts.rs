//! 提示词数据访问对象
//!
//! 提供提示词（Prompt）的 CRUD 操作。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::prompt::{Prompt, PromptCategory};
use indexmap::IndexMap;
use rusqlite::params;

impl Database {
    /// Seed once per tool, not whenever its category list becomes empty.
    pub fn get_prompt_categories(&self, app: &str) -> Result<Vec<PromptCategory>, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let key = format!("prompt_categories_initialized:{app}");
        let initialized: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
                [&key],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if !initialized {
            let empty: bool = tx
                .query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM prompt_categories WHERE app_type = ?1)",
                    [app],
                    |row| row.get(0),
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            // Existing library categories always take precedence over defaults.
            if empty {
                for (index, (id, name)) in
                    [("software-development", "软件开发"), ("writing", "写作")]
                        .iter()
                        .enumerate()
                {
                    tx.execute("INSERT INTO prompt_categories (id, app_type, name, sort_index) VALUES (?1, ?2, ?3, ?4)",
                        params![id, app, name, index as i64]).map_err(|e| AppError::Database(e.to_string()))?;
                }
            }
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, 'true')",
                [&key],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        let categories = read_categories(&tx, app)?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(categories)
    }

    pub fn create_prompt_category(&self, app: &str, name: &str) -> Result<String, AppError> {
        let conn = lock_conn!(self.conn);
        let name = validate_category_name(&conn, app, None, name)?;
        let id = format!("category-{}", uuid::Uuid::new_v4());
        conn.execute(
            "INSERT INTO prompt_categories (id, app_type, name, sort_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_index), -1) + 1 FROM prompt_categories WHERE app_type = ?2), strftime('%s','now'), strftime('%s','now'))",
            params![id, app, name],
        ).map_err(|e| AppError::Database(e.to_string()))?;
        Ok(id)
    }

    pub fn rename_prompt_category(&self, app: &str, id: &str, name: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let name = validate_category_name(&conn, app, Some(id), name)?;
        let changed = conn.execute(
            "UPDATE prompt_categories SET name = ?3, updated_at = strftime('%s','now') WHERE app_type = ?1 AND id = ?2",
            params![app, id, name],
        ).map_err(|e| AppError::Database(e.to_string()))?;
        if changed == 0 {
            return Err(AppError::InvalidInput("分类不存在，请刷新后重试。".into()));
        }
        Ok(())
    }

    /// Metadata only: never write instructions or change activation state.
    pub fn delete_prompt_category(&self, app: &str, id: &str) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        let changed = tx
            .execute(
                "DELETE FROM prompt_categories WHERE app_type = ?1 AND id = ?2",
                params![app, id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if changed == 0 {
            return Err(AppError::InvalidInput("分类不存在，请刷新后重试。".into()));
        }
        tx.execute(
            "UPDATE prompts SET category_id = NULL WHERE app_type = ?1 AND category_id = ?2",
            params![app, id],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        tx.commit().map_err(|e| AppError::Database(e.to_string()))
    }

    pub(crate) fn validate_prompt_category(
        &self,
        app: &str,
        id: Option<&str>,
    ) -> Result<(), AppError> {
        let Some(id) = id else {
            return Ok(());
        };
        let conn = lock_conn!(self.conn);
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM prompt_categories WHERE app_type = ?1 AND id = ?2)",
                params![app, id],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if !exists {
            return Err(AppError::InvalidInput("分类不存在，请刷新后重试。".into()));
        }
        Ok(())
    }

    /// 获取指定应用类型的所有提示词
    pub fn get_prompts(&self, app_type: &str) -> Result<IndexMap<String, Prompt>, AppError> {
        let conn = lock_conn!(self.conn);
        read_prompts(&conn, app_type)
    }

    /// 保存提示词
    pub fn save_prompt(&self, app_type: &str, prompt: &Prompt) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        // Update in place so the v17 library columns (filename, category,
        // origin, template) survive a save; REPLACE would reset them.
        let updated = conn
            .execute(
                "UPDATE prompts SET name = ?3, content = ?4, description = ?5, enabled = ?6,
                     created_at = ?7, updated_at = ?8, template_id = COALESCE(?9, template_id),
                     category_id = COALESCE(?10, category_id)
                 WHERE id = ?1 AND app_type = ?2",
                params![
                    prompt.id,
                    app_type,
                    prompt.name,
                    prompt.content,
                    prompt.description,
                    prompt.enabled,
                    prompt.created_at,
                    prompt.updated_at,
                    prompt.template_id,
                    prompt.category_id,
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated == 0 {
            // Rows this writer creates for Codex are whole-file AGENTS.md
            // prompts, the same kind the v17 migration marks.
            conn.execute(
                "INSERT INTO prompts (
                    id, app_type, name, content, description, enabled, created_at, updated_at, origin, template_id, category_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                          CASE WHEN ?2 = 'codex' THEN ?9 END, ?10, ?11)",
                params![
                    prompt.id,
                    app_type,
                    prompt.name,
                    prompt.content,
                    prompt.description,
                    prompt.enabled,
                    prompt.created_at,
                    prompt.updated_at,
                    crate::database::PROMPT_ORIGIN_LEGACY_WHOLE_FILE,
                    prompt.template_id,
                    prompt.category_id,
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    /// Only the legacy row that previously owned the whole file may be adopted.
    pub(crate) fn codex_legacy_prompt_hash(
        &self,
    ) -> Result<Option<crate::config::cas::ContentHash>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare("SELECT content FROM prompts WHERE app_type = 'codex' AND enabled = 1 AND origin = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let contents = stmt
            .query_map([crate::database::PROMPT_ORIGIN_LEGACY_WHOLE_FILE], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| AppError::Database(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(e.to_string()))?;
        match contents.as_slice() {
            [] => Ok(None),
            [content] => Ok(Some(crate::config::cas::ContentHash::of(
                content.as_bytes(),
            ))),
            _ => Err(AppError::InvalidInput(
                "存在多个旧版整文件提示词，请先解决所有权冲突。".into(),
            )),
        }
    }

    /// Short DB-only transaction, after the file CAS. Verify the observed rows
    /// before committing; the caller rolls the files back on any failure.
    pub(crate) fn commit_codex_prompts(
        &self,
        expected: &IndexMap<String, Prompt>,
        next: &IndexMap<String, Prompt>,
        projected: bool,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;
        if read_prompts(&tx, "codex")? != *expected {
            return Err(AppError::InvalidInput(
                "提示词在操作期间已变化，请刷新后重试。".into(),
            ));
        }
        for prompt in next.values() {
            tx.execute(
                "INSERT INTO prompts (id, app_type, name, content, description, enabled, created_at, updated_at, origin, template_id, category_id)
                 VALUES (?1, 'codex', ?2, ?3, ?4, ?5, ?6, ?7, 'managed', ?9, ?10)
                 ON CONFLICT(id, app_type) DO UPDATE SET name=excluded.name, content=excluded.content,
                 description=excluded.description, enabled=excluded.enabled, created_at=excluded.created_at,
                 updated_at=excluded.updated_at, template_id=COALESCE(excluded.template_id, prompts.template_id),
                 category_id=excluded.category_id,
                 origin=CASE WHEN ?8 AND prompts.origin = 'legacy-whole-file' THEN 'managed' ELSE prompts.origin END",
                params![prompt.id, prompt.name, prompt.content, prompt.description, prompt.enabled, prompt.created_at, prompt.updated_at, projected, prompt.template_id, prompt.category_id],
            ).map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| AppError::Database(e.to_string()))
    }

    /// 删除提示词
    pub fn delete_prompt(&self, app_type: &str, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let removed = conn
            .execute(
                "DELETE FROM prompts WHERE id = ?1 AND app_type = ?2 AND enabled = 0",
                params![id, app_type],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if removed == 0 {
            return Err(AppError::InvalidInput(
                "提示词已启用或不存在，请刷新后重试。".into(),
            ));
        }
        Ok(())
    }
}

fn read_categories(
    conn: &rusqlite::Connection,
    app: &str,
) -> Result<Vec<PromptCategory>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name FROM prompt_categories WHERE app_type = ?1 ORDER BY sort_index, id",
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
    let rows = stmt
        .query_map([app], |row| {
            Ok(PromptCategory {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| AppError::Database(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Database(e.to_string()))
}

fn validate_category_name(
    conn: &rusqlite::Connection,
    app: &str,
    id: Option<&str>,
    name: &str,
) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 50 || name.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "分类名称需为 1–50 个字符，且不能包含控制字符。".into(),
        ));
    }
    if ["全部", "全部分类", "未分类"].contains(&name) {
        return Err(AppError::InvalidInput("该分类名称为系统保留名称。".into()));
    }
    if read_categories(conn, app)?.iter().any(|category| {
        Some(category.id.as_str()) != id && category.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(AppError::InvalidInput("分类名称已存在。".into()));
    }
    Ok(name.to_string())
}

fn read_prompts(
    conn: &rusqlite::Connection,
    app_type: &str,
) -> Result<IndexMap<String, Prompt>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, content, description, enabled, created_at, updated_at, template_id, category_id
             FROM prompts WHERE app_type = ?1
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

    let prompt_iter = stmt
        .query_map(params![app_type], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let content: String = row.get(2)?;
            let description: Option<String> = row.get(3)?;
            let enabled: bool = row.get(4)?;
            let created_at: Option<i64> = row.get(5)?;
            let updated_at: Option<i64> = row.get(6)?;

            Ok((
                id.clone(),
                Prompt {
                    template_id: row.get(7)?,
                    category_id: row.get(8)?,
                    id,
                    name,
                    content,
                    description,
                    enabled,
                    created_at,
                    updated_at,
                },
            ))
        })
        .map_err(|e| AppError::Database(e.to_string()))?;

    let mut prompts = IndexMap::new();
    for prompt_res in prompt_iter {
        let (id, prompt) = prompt_res.map_err(|e| AppError::Database(e.to_string()))?;
        prompts.insert(id, prompt);
    }
    Ok(prompts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_seed_once_validate_names_and_are_isolated() {
        let db = Database::memory().unwrap();
        let defaults = db.get_prompt_categories("codex").unwrap();
        assert_eq!(defaults.len(), 2);
        db.rename_prompt_category("codex", "writing", "文案")
            .unwrap();
        assert_eq!(db.get_prompt_categories("codex").unwrap()[1].name, "文案");
        assert_eq!(db.get_prompt_categories("claude").unwrap()[1].name, "写作");
        let id = db.create_prompt_category("codex", " Review ").unwrap();
        assert!(db.create_prompt_category("codex", "review").is_err());
        for name in ["", "  ", "未分类", "全部", "全部分类", "bad\nname"] {
            assert!(db.create_prompt_category("codex", name).is_err());
        }
        assert!(db
            .create_prompt_category("codex", &"文".repeat(51))
            .is_err());
        assert!(db
            .rename_prompt_category("codex", "missing", "New")
            .is_err());
        assert!(db.validate_prompt_category("claude", Some(&id)).is_err());
        for category in db.get_prompt_categories("codex").unwrap() {
            db.delete_prompt_category("codex", &category.id).unwrap();
        }
        assert!(db.get_prompt_categories("codex").unwrap().is_empty());
        assert_eq!(db.get_prompt_categories("claude").unwrap().len(), 2);
    }

    #[test]
    fn category_initialization_preserves_existing_customizations() {
        let db = Database::memory().unwrap();
        db.conn.lock().unwrap().execute_batch(
            "INSERT INTO settings (key, value) VALUES ('prompt_categories_initialized:codex', 'true');
             INSERT INTO prompt_categories (id, app_type, name, sort_index) VALUES ('writing', 'codex', '文案', 7);"
        ).unwrap();
        let categories = db.get_prompt_categories("codex").unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "writing");
        assert_eq!(categories[0].name, "文案");
        db.delete_prompt_category("codex", "writing").unwrap();
        assert!(db.get_prompt_categories("codex").unwrap().is_empty());
    }

    #[test]
    fn category_initialization_keeps_existing_custom_categories() {
        let db = Database::memory().unwrap();
        let id = db.create_prompt_category("codex", "研究").unwrap();
        let categories = db.get_prompt_categories("codex").unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, id);
        assert_eq!(categories[0].name, "研究");
        db.delete_prompt_category("codex", &id).unwrap();
        assert!(db.get_prompt_categories("codex").unwrap().is_empty());
    }

    #[test]
    fn deleting_category_is_atomic_and_preserves_prompt_content_and_state() {
        let db = Database::memory().unwrap();
        db.get_prompt_categories("codex").unwrap();
        db.get_prompt_categories("claude").unwrap();
        let value: Prompt = serde_json::from_value(serde_json::json!({
            "id":"rules", "name":"Rules", "content":" body\n", "enabled":true, "categoryId":"writing"
        })).unwrap();
        db.save_prompt("codex", &value).unwrap();
        db.save_prompt("claude", &value).unwrap();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_category_clear BEFORE UPDATE ON prompts BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(db.delete_prompt_category("codex", "writing").is_err());
        assert_eq!(db.get_prompt_categories("codex").unwrap().len(), 2);
        assert_eq!(db.get_prompts("codex").unwrap()["rules"], value);
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_category_clear")
            .unwrap();
        db.delete_prompt_category("codex", "writing").unwrap();
        let mut cleared = value.clone();
        cleared.category_id = None;
        assert_eq!(db.get_prompts("codex").unwrap()["rules"], cleared);
        assert_eq!(db.get_prompts("claude").unwrap()["rules"], value);
    }

    #[test]
    fn category_assignments_roundtrip_and_can_be_cleared_in_managed_commits() {
        let db = Database::memory().unwrap();
        db.get_prompt_categories("codex").unwrap();
        let value: Prompt = serde_json::from_value(serde_json::json!({
            "id":"rules", "name":"Rules", "content":"body", "enabled":false, "categoryId":"writing"
        }))
        .unwrap();
        let mut next = IndexMap::new();
        next.insert(value.id.clone(), value);
        db.commit_codex_prompts(&IndexMap::new(), &next, false)
            .unwrap();
        assert_eq!(db.get_prompts("codex").unwrap(), next);
        let before = next.clone();
        next.get_mut("rules").unwrap().category_id = None;
        db.commit_codex_prompts(&before, &next, false).unwrap();
        assert_eq!(db.get_prompts("codex").unwrap(), next);
        assert!(db.commit_codex_prompts(&before, &next, false).is_err());
    }

    #[test]
    fn template_provenance_roundtrips_and_survives_legacy_saves() {
        let db = Database::memory().unwrap();
        let prompt = Prompt {
            id: "copy".into(),
            name: "Copy".into(),
            content: "Rules".into(),
            description: None,
            enabled: false,
            created_at: Some(1),
            updated_at: Some(1),
            template_id: Some("software-development-code-review".into()),
            category_id: None,
        };
        db.save_prompt("codex", &prompt).unwrap();
        assert_eq!(db.get_prompts("codex").unwrap()["copy"], prompt);
        let mut legacy = prompt.clone();
        legacy.template_id = None;
        db.save_prompt("codex", &legacy).unwrap();
        assert_eq!(db.get_prompts("codex").unwrap()["copy"], prompt);
        let expected = db.get_prompts("codex").unwrap();
        let mut next = expected.clone();
        next.get_mut("copy").unwrap().enabled = true;
        db.commit_codex_prompts(&expected, &next, true).unwrap();
        assert_eq!(db.get_prompts("codex").unwrap(), next);
        let mut stale = next.clone();
        stale.get_mut("copy").unwrap().template_id = None;
        assert!(db.commit_codex_prompts(&stale, &next, false).is_err());
    }

    #[test]
    fn managed_template_copy_inserts_provenance() {
        let db = Database::memory().unwrap();
        let prompt: Prompt = serde_json::from_value(serde_json::json!({
            "id": "copy", "name": "Copy", "content": "Rules", "enabled": false,
            "templateId": "writing-technical-docs"
        }))
        .unwrap();
        let mut next = IndexMap::new();
        next.insert(prompt.id.clone(), prompt.clone());
        db.commit_codex_prompts(&IndexMap::new(), &next, false)
            .unwrap();
        let actual = db.get_prompts("codex").unwrap();
        assert_eq!(actual, next);
        assert_eq!(
            serde_json::to_value(&actual["copy"]).unwrap()["templateId"],
            "writing-technical-docs"
        );
    }
}
