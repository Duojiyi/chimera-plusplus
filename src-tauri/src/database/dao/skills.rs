//! Skills 数据访问对象
//!
//! 提供 Skills 和 Skill Repos 的 CRUD 操作。
//!
//! v3.10.0+ 统一管理架构：
//! - Skills 使用统一的 id 主键，支持四应用启用标志
//! - 实际文件存储在 ~/.cc-switch/skills/，同步到各应用目录

use crate::app_config::{InstalledSkill, SkillApps};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::skill::SkillRepo;
use indexmap::IndexMap;
use rusqlite::{params, TransactionBehavior};
use std::collections::HashSet;

impl Database {
    // ========== InstalledSkill CRUD ==========

    /// 获取所有已安装的 Skills
    pub fn get_all_installed_skills(&self) -> Result<IndexMap<String, InstalledSkill>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, directory, repo_owner, repo_name, repo_branch,
                        readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild,
                        enabled_opencode, enabled_hermes, installed_at, content_hash, updated_at
                 FROM skills ORDER BY name ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let skill_iter = stmt
            .query_map([], |row| {
                Ok(InstalledSkill {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    directory: row.get(3)?,
                    repo_owner: row.get(4)?,
                    repo_name: row.get(5)?,
                    repo_branch: row.get(6)?,
                    readme_url: row.get(7)?,
                    apps: SkillApps {
                        claude: row.get(8)?,
                        codex: row.get(9)?,
                        gemini: row.get(10)?,
                        grokbuild: row.get(11)?,
                        opencode: row.get(12)?,
                        hermes: row.get(13)?,
                    },
                    installed_at: row.get(14)?,
                    content_hash: row.get(15)?,
                    updated_at: row.get::<_, i64>(16).unwrap_or(0),
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut skills = IndexMap::new();
        for skill_res in skill_iter {
            let skill = skill_res.map_err(|e| AppError::Database(e.to_string()))?;
            skills.insert(skill.id.clone(), skill);
        }
        Ok(skills)
    }

    /// 获取单个已安装的 Skill
    pub fn get_installed_skill(&self, id: &str) -> Result<Option<InstalledSkill>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, directory, repo_owner, repo_name, repo_branch,
                        readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild,
                        enabled_opencode, enabled_hermes, installed_at, content_hash, updated_at
                 FROM skills WHERE id = ?1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let result = stmt.query_row([id], |row| {
            Ok(InstalledSkill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                directory: row.get(3)?,
                repo_owner: row.get(4)?,
                repo_name: row.get(5)?,
                repo_branch: row.get(6)?,
                readme_url: row.get(7)?,
                apps: SkillApps {
                    claude: row.get(8)?,
                    codex: row.get(9)?,
                    gemini: row.get(10)?,
                    grokbuild: row.get(11)?,
                    opencode: row.get(12)?,
                    hermes: row.get(13)?,
                },
                installed_at: row.get(14)?,
                content_hash: row.get(15)?,
                updated_at: row.get::<_, i64>(16).unwrap_or(0),
            })
        });

        match result {
            Ok(skill) => Ok(Some(skill)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    /// 保存 Skill（添加或更新）
    pub fn save_skill(&self, skill: &InstalledSkill) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        // Update in place so the v17 `notes` column survives a save; REPLACE
        // would delete the row and reset it.
        let updated = conn
            .execute(
                "UPDATE skills SET name = ?2, description = ?3, directory = ?4, repo_owner = ?5,
                     repo_name = ?6, repo_branch = ?7, readme_url = ?8, enabled_claude = ?9,
                     enabled_codex = ?10, enabled_gemini = ?11, enabled_grokbuild = ?12,
                     enabled_opencode = ?13, enabled_hermes = ?14, installed_at = ?15,
                     content_hash = ?16, updated_at = ?17
                 WHERE id = ?1",
                params![
                    skill.id,
                    skill.name,
                    skill.description,
                    skill.directory,
                    skill.repo_owner,
                    skill.repo_name,
                    skill.repo_branch,
                    skill.readme_url,
                    skill.apps.claude,
                    skill.apps.codex,
                    skill.apps.gemini,
                    skill.apps.grokbuild,
                    skill.apps.opencode,
                    skill.apps.hermes,
                    skill.installed_at,
                    skill.content_hash,
                    skill.updated_at,
                ],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated > 0 {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO skills
             (id, name, description, directory, repo_owner, repo_name, repo_branch,
              readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode, enabled_hermes,
              installed_at, content_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                skill.id,
                skill.name,
                skill.description,
                skill.directory,
                skill.repo_owner,
                skill.repo_name,
                skill.repo_branch,
                skill.readme_url,
                skill.apps.claude,
                skill.apps.codex,
                skill.apps.gemini,
                skill.apps.grokbuild,
                skill.apps.opencode,
                skill.apps.hermes,
                skill.installed_at,
                skill.content_hash,
                skill.updated_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除 Skill
    pub fn delete_skill(&self, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute("DELETE FROM skills WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }

    /// 清空所有 Skills（用于迁移）
    pub fn clear_skills(&self) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM skills", [])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 原子地写入 Skill/仓库状态。
    ///
    /// `clear_skills_first` 仅用于一次性迁移；普通导入必须传 `false`，
    /// 这样数据库错误或并发冲突时整个批次都会回滚，不会留下部分 Skill 或仓库记录。
    pub fn apply_skills_and_repos_atomic(
        &self,
        skills: &[InstalledSkill],
        repos: &[SkillRepo],
        clear_skills_first: bool,
        clear_setting_key: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        // 先取得写锁，再在同一事务中重做冲突检查；不能依赖调用方事务外的预检查。
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AppError::Database(format!("开启 Skill 事务失败: {e}")))?;

        let mut batch_ids = HashSet::with_capacity(skills.len());
        let mut batch_directories = HashSet::with_capacity(skills.len());
        for skill in skills {
            if !batch_ids.insert(skill.id.clone()) {
                return Err(AppError::Database(format!(
                    "同一批次包含重复 Skill ID: {}",
                    skill.id
                )));
            }
            if !batch_directories.insert(skill.directory.clone()) {
                return Err(AppError::Database(format!(
                    "同一批次包含重复 Skill 目录: {}",
                    skill.directory
                )));
            }
        }

        if clear_skills_first {
            tx.execute("DELETE FROM skills", [])
                .map_err(|e| AppError::Database(format!("清空 Skills 失败: {e}")))?;
        } else {
            // 普通导入不能覆盖现有记录。由于事务使用 IMMEDIATE 写锁，
            // 这里的检查与后续 INSERT 之间不会被另一写事务插入竞争数据。
            for skill in skills {
                let id_exists: i64 = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM skills WHERE id = ?1)",
                        params![skill.id],
                        |row| row.get(0),
                    )
                    .map_err(|e| {
                        AppError::Database(format!("检查 Skill ID {} 失败: {e}", skill.id))
                    })?;
                if id_exists != 0 {
                    return Err(AppError::Database(format!(
                        "拒绝覆盖已有 ID 的 Skill: {}",
                        skill.id
                    )));
                }

                let directory_exists: i64 = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM skills WHERE directory = ?1)",
                        params![skill.directory],
                        |row| row.get(0),
                    )
                    .map_err(|e| {
                        AppError::Database(format!("检查 Skill 目录 {} 失败: {e}", skill.directory))
                    })?;
                if directory_exists != 0 {
                    return Err(AppError::Database(format!(
                        "拒绝覆盖已有数据库记录的 Skill: {}",
                        skill.directory
                    )));
                }
            }
        }

        for skill in skills {
            tx.execute(
                "INSERT INTO skills
                 (id, name, description, directory, repo_owner, repo_name, repo_branch,
                  readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode, enabled_hermes,
                  installed_at, content_hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    skill.id,
                    skill.name,
                    skill.description,
                    skill.directory,
                    skill.repo_owner,
                    skill.repo_name,
                    skill.repo_branch,
                    skill.readme_url,
                    skill.apps.claude,
                    skill.apps.codex,
                    skill.apps.gemini,
                    skill.apps.grokbuild,
                    skill.apps.opencode,
                    skill.apps.hermes,
                    skill.installed_at,
                    skill.content_hash,
                    skill.updated_at,
                ],
            )
            .map_err(|e| AppError::Database(format!("写入 Skill {} 失败: {e}", skill.id)))?;
        }

        // 只补充 lock 中的新仓库，不覆盖用户已经调整的分支/启用状态。
        for repo in repos {
            tx.execute(
                "INSERT OR IGNORE INTO skill_repos (owner, name, branch, enabled) VALUES (?1, ?2, ?3, ?4)",
                params![repo.owner, repo.name, repo.branch, repo.enabled],
            )
            .map_err(|e| {
                AppError::Database(format!(
                    "写入 Skill 仓库 {}/{} 失败: {e}",
                    repo.owner, repo.name
                ))
            })?;
        }

        if let Some(key) = clear_setting_key {
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, ""],
            )
            .map_err(|e| AppError::Database(format!("清理迁移快照失败: {e}")))?;
        }

        tx.commit()
            .map_err(|e| AppError::Database(format!("提交 Skill 事务失败: {e}")))?;
        Ok(())
    }

    /// 更新 Skill 的应用启用状态
    pub fn update_skill_apps(&self, id: &str, apps: &SkillApps) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute(
                "UPDATE skills SET enabled_claude = ?1, enabled_codex = ?2, enabled_gemini = ?3, enabled_grokbuild = ?4, enabled_opencode = ?5, enabled_hermes = ?6 WHERE id = ?7",
                params![apps.claude, apps.codex, apps.gemini, apps.grokbuild, apps.opencode, apps.hermes, id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }

    /// 更新 Skill 的内容哈希和更新时间
    pub fn update_skill_hash(
        &self,
        id: &str,
        content_hash: &str,
        updated_at: i64,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let affected = conn
            .execute(
                "UPDATE skills SET content_hash = ?1, updated_at = ?2 WHERE id = ?3",
                params![content_hash, updated_at, id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }

    // ========== SkillRepo CRUD（保持原有） ==========

    /// 获取所有 Skill 仓库
    pub fn get_skill_repos(&self) -> Result<Vec<SkillRepo>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT owner, name, branch, enabled FROM skill_repos ORDER BY owner ASC, name ASC",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;

        let repo_iter = stmt
            .query_map([], |row| {
                Ok(SkillRepo {
                    owner: row.get(0)?,
                    name: row.get(1)?,
                    branch: row.get(2)?,
                    enabled: row.get(3)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut repos = Vec::new();
        for repo_res in repo_iter {
            repos.push(repo_res.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(repos)
    }

    /// 保存 Skill 仓库
    pub fn save_skill_repo(&self, repo: &SkillRepo) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO skill_repos (owner, name, branch, enabled) VALUES (?1, ?2, ?3, ?4)",
            params![repo.owner, repo.name, repo.branch, repo.enabled],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 删除 Skill 仓库
    pub fn delete_skill_repo(&self, owner: &str, name: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM skill_repos WHERE owner = ?1 AND name = ?2",
            params![owner, name],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// 初始化默认的 Skill 仓库（启动时调用，每个数据库仅执行一次）
    pub fn init_default_skill_repos(&self) -> Result<usize, AppError> {
        const INITIALIZED_KEY: &str = "default_skill_repos_initialized";

        if self.get_bool_flag(INITIALIZED_KEY)? {
            return Ok(0);
        }

        // 兼容升级前已经存在的用户选择，并记录初始化状态，避免以后删空后恢复默认值。
        if !self.get_skill_repos()?.is_empty() {
            self.set_setting(INITIALIZED_KEY, "true")?;
            return Ok(0);
        }

        let default_store = crate::services::skill::SkillStore::default();
        let mut count = 0;

        for repo in &default_store.repos {
            self.save_skill_repo(repo)?;
            count += 1;
            log::info!("初始化默认 Skill 仓库: {}/{}", repo.owner, repo.name);
        }

        self.set_setting(INITIALIZED_KEY, "true")?;
        Ok(count)
    }
}
