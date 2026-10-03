//! 提示词数据访问对象
//!
//! 提供提示词（Prompt）的 CRUD 操作。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::prompt::Prompt;
use indexmap::IndexMap;
use rusqlite::params;

impl Database {
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
                     created_at = ?7, updated_at = ?8, template_id = COALESCE(?9, template_id)
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
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated == 0 {
            // Rows this writer creates for Codex are whole-file AGENTS.md
            // prompts, the same kind the v17 migration marks.
            conn.execute(
                "INSERT INTO prompts (
                    id, app_type, name, content, description, enabled, created_at, updated_at, origin, template_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                          CASE WHEN ?2 = 'codex' THEN ?9 END, ?10)",
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
                "INSERT INTO prompts (id, app_type, name, content, description, enabled, created_at, updated_at, origin, template_id)
                 VALUES (?1, 'codex', ?2, ?3, ?4, ?5, ?6, ?7, 'managed', ?9)
                 ON CONFLICT(id, app_type) DO UPDATE SET name=excluded.name, content=excluded.content,
                 description=excluded.description, enabled=excluded.enabled, created_at=excluded.created_at,
                 updated_at=excluded.updated_at, template_id=COALESCE(excluded.template_id, prompts.template_id),
                 origin=CASE WHEN ?8 AND prompts.origin = 'legacy-whole-file' THEN 'managed' ELSE prompts.origin END",
                params![prompt.id, prompt.name, prompt.content, prompt.description, prompt.enabled, prompt.created_at, prompt.updated_at, projected, prompt.template_id],
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

fn read_prompts(
    conn: &rusqlite::Connection,
    app_type: &str,
) -> Result<IndexMap<String, Prompt>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, content, description, enabled, created_at, updated_at, template_id
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
