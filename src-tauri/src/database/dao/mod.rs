//! Data Access Object layer
//!
//! Database access operations for each domain

pub mod failover;
pub mod mcp;
pub mod notes;
pub mod official_accounts;
pub mod profiles;
pub mod prompts;
pub mod providers;
pub mod providers_seed;
pub mod proxy;
pub mod settings;
pub mod skills;
pub mod stream_check;
pub mod universal_providers;
pub mod usage_rollup;

// 所有 DAO 方法都通过 Database impl 提供，无需单独导出
// 导出 FailoverQueueItem / Profile 供外部使用
pub use failover::FailoverQueueItem;
pub use notes::NotesTable;
pub use profiles::Profile;

use crate::error::AppError;
use indexmap::IndexMap;

/// 库里有、但存的 JSON 读不出来的一行。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct UnreadableEntry {
    pub id: String,
    pub name: String,
    pub error: String,
}

/// 一次列表读取的结果：能读的行，和读不出来的行。
#[allow(dead_code)]
pub struct Rows<T> {
    pub readable: IndexMap<String, T>,
    pub unreadable: Vec<UnreadableEntry>,
}

#[allow(dead_code)]
impl<T> Rows<T> {
    pub fn into_strict(self) -> Result<IndexMap<String, T>, AppError> {
        match self.unreadable.into_iter().next() {
            Some(entry) => Err(AppError::Database(entry.error)),
            None => Ok(self.readable),
        }
    }

    pub fn into_readable(self, purpose: &str) -> IndexMap<String, T> {
        for entry in &self.unreadable {
            log::warn!("{purpose}: 跳过读不出来的 {}: {}", entry.id, entry.error);
        }
        self.readable
    }

    pub fn into_readable_and_unreadable_ids(self) -> (IndexMap<String, T>, Vec<String>) {
        let ids = self.unreadable.into_iter().map(|entry| entry.id).collect();
        (self.readable, ids)
    }
}
