//! Codex 运行时安装事务日志（v2.5.0 M3 / TASK-007、TASK-008）。
//!
//! 每次安装/更新/离线导入在破坏性操作前持久化一条日志；便携安装路径通过
//! `codex_win_engine::PortableBoundary` 观察者在每个 rename 边界更新状态，
//! 记录真实的 staging / 备份目录。应用启动时把仍处于进行中的条目标记为
//! `interrupted`，由 UI 提示用户执行恢复（回滚到备份或清理记录）——恢复
//! 是显式操作，启动阶段绝不自动改动安装目录。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::atomic_write;
use crate::error::AppError;

pub const JOURNAL_FILENAME: &str = "install-journal.json";
/// 日志按时间保留最近 N 条，避免无界增长。
const MAX_ENTRIES: usize = 32;

/// 单次安装事务的持久化状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallJournalEntry {
    pub id: String,
    /// Unix 秒
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub version: String,
    pub install_mode: String,
    /// `mirror:latest` / `mirror:<tag>` / `offline:<文件名>`
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// `started` → (`moving:*`) → `completed` | `failed` | `rolled_back`；
    /// 崩溃后启动时进行中的条目被改写为 `interrupted`；
    /// 用户处理后改写为 `acknowledged`。
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 破坏性窗口内引擎报告的备份目录（崩溃恢复线索）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

impl InstallJournalEntry {
    fn is_in_flight(&self) -> bool {
        self.state == "started" || self.state.starts_with("moving:")
    }
}

/// 基于单个 JSON 文件的安装事务日志。所有写入走 `atomic_write`。
pub struct InstallJournal {
    path: PathBuf,
}

impl InstallJournal {
    pub fn at(dir: &Path) -> Self {
        Self {
            path: dir.join(JOURNAL_FILENAME),
        }
    }

    pub fn load(&self) -> Vec<InstallJournalEntry> {
        let Ok(content) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        serde_json::from_str(&content).unwrap_or_else(|error| {
            log::warn!("[InstallJournal] 日志文件解析失败，按空日志处理: {error}");
            Vec::new()
        })
    }

    fn save(&self, entries: &[InstallJournalEntry]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        let json = serde_json::to_vec_pretty(entries)
            .map_err(|e| AppError::Config(format!("序列化安装日志失败: {e}")))?;
        atomic_write(&self.path, &json)
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// 开始一次安装事务，返回条目 ID。
    pub fn begin(
        &self,
        version: &str,
        install_mode: &str,
        source: &str,
        sha256: Option<&str>,
    ) -> Result<String, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut entries = self.load();
        entries.push(InstallJournalEntry {
            id: id.clone(),
            started_at: Self::now(),
            finished_at: None,
            version: version.to_string(),
            install_mode: install_mode.to_string(),
            source: source.to_string(),
            sha256: sha256.map(str::to_string),
            state: "started".to_string(),
            detail: None,
            backup_path: None,
        });
        if entries.len() > MAX_ENTRIES {
            let excess = entries.len() - MAX_ENTRIES;
            entries.drain(0..excess);
        }
        self.save(&entries)?;
        Ok(id)
    }

    /// 更新指定条目（状态机转移、备份路径等）。
    pub fn update(
        &self,
        id: &str,
        apply: impl FnOnce(&mut InstallJournalEntry),
    ) -> Result<(), AppError> {
        let mut entries = self.load();
        if let Some(entry) = entries.iter_mut().find(|entry| entry.id == id) {
            apply(entry);
            self.save(&entries)?;
        }
        Ok(())
    }

    /// 结束一次事务：`completed` / `failed` / `rolled_back`。
    pub fn finish(&self, id: &str, state: &str, detail: Option<String>) -> Result<(), AppError> {
        self.update(id, |entry| {
            entry.state = state.to_string();
            entry.finished_at = Some(Self::now());
            entry.detail = detail;
        })
    }

    /// 启动时调用：把上次进程生命周期内未完结的条目标记为 `interrupted`，
    /// 返回被标记的条目供日志/UI 使用。
    pub fn mark_interrupted(&self) -> Result<Vec<InstallJournalEntry>, AppError> {
        let mut entries = self.load();
        let mut interrupted = Vec::new();
        for entry in entries.iter_mut() {
            if entry.is_in_flight() {
                entry.state = "interrupted".to_string();
                entry.finished_at = Some(Self::now());
                interrupted.push(entry.clone());
            }
        }
        if !interrupted.is_empty() {
            self.save(&entries)?;
        }
        Ok(interrupted)
    }

    /// 等待用户处理的中断条目。
    pub fn pending_recovery(&self) -> Vec<InstallJournalEntry> {
        self.load()
            .into_iter()
            .filter(|entry| entry.state == "interrupted")
            .collect()
    }

    /// 用户已处理（回滚或确认忽略）一个中断条目。
    pub fn acknowledge(&self, id: &str) -> Result<(), AppError> {
        self.update(id, |entry| {
            entry.state = "acknowledged".to_string();
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, InstallJournal) {
        let dir = tempfile::tempdir().unwrap();
        let journal = InstallJournal::at(dir.path());
        (dir, journal)
    }

    #[test]
    fn begin_finish_roundtrip() {
        let (_dir, journal) = journal();
        let id = journal
            .begin("26.721", "portable", "mirror:latest", Some("abc123"))
            .unwrap();

        let entries = journal.load();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, "started");
        assert_eq!(entries[0].sha256.as_deref(), Some("abc123"));

        journal
            .finish(&id, "completed", Some("done".to_string()))
            .unwrap();
        let entries = journal.load();
        assert_eq!(entries[0].state, "completed");
        assert!(entries[0].finished_at.is_some());
        assert_eq!(entries[0].detail.as_deref(), Some("done"));
    }

    #[test]
    fn interrupted_entries_are_detected_on_startup() {
        let (_dir, journal) = journal();
        let started = journal
            .begin("26.721", "portable", "offline:codex.msix", None)
            .unwrap();
        let moving = journal
            .begin("26.722", "portable", "mirror:v1", None)
            .unwrap();
        journal
            .update(&moving, |entry| {
                entry.state = "moving:after_move_old".to_string();
                entry.backup_path = Some("C:/x/Codex.rollback-1".to_string());
            })
            .unwrap();
        let done = journal
            .begin("26.723", "standard", "mirror:latest", None)
            .unwrap();
        journal.finish(&done, "completed", None).unwrap();

        let interrupted = journal.mark_interrupted().unwrap();
        assert_eq!(interrupted.len(), 2);
        assert!(interrupted.iter().any(|entry| entry.id == started));
        assert!(interrupted.iter().any(|entry| entry.id == moving
            && entry.backup_path.as_deref() == Some("C:/x/Codex.rollback-1")));

        let pending = journal.pending_recovery();
        assert_eq!(pending.len(), 2);

        journal.acknowledge(&started).unwrap();
        assert_eq!(journal.pending_recovery().len(), 1);

        // 已完结条目不受影响
        assert!(journal
            .load()
            .iter()
            .any(|entry| entry.id == done && entry.state == "completed"));
    }

    #[test]
    fn journal_is_bounded() {
        let (_dir, journal) = journal();
        for index in 0..40 {
            journal
                .begin(&format!("v{index}"), "portable", "mirror:latest", None)
                .unwrap();
        }
        assert_eq!(journal.load().len(), 32);
    }

    #[test]
    fn corrupt_journal_degrades_to_empty() {
        let (dir, journal) = journal();
        std::fs::write(dir.path().join(JOURNAL_FILENAME), "not json").unwrap();
        assert!(journal.load().is_empty());
        // 仍可正常写入新条目
        journal
            .begin("v", "portable", "mirror:latest", None)
            .unwrap();
        assert_eq!(journal.load().len(), 1);
    }
}
