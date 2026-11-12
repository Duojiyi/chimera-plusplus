//! v18 account metadata for Codex official accounts: tags, groups, notes,
//! the "held out of use" flag and the last-used stamp.
//!
//! Nothing here is a credential: the encrypted slot stays in
//! `codex_accounts::vault`, and this table only holds the user's labels for
//! it, keyed by account key so the labels outlive a re-created slot.
use std::collections::HashMap;

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::official_account_meta::{AccountGroup, AccountMeta, AccountMetaIndex};
use rusqlite::params;

/// One row of `official_account_quota`. The payload is the reading as JSON:
/// what it means (and whether it is still fresh) is decided by
/// `services::official_quota_cache`, not here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OfficialQuotaRow {
    pub(crate) payload: String,
    /// Milliseconds since the epoch of the last successful reading, 0 if none.
    pub(crate) fetched_at: i64,
    /// Milliseconds since the epoch of the last attempt, 0 if none.
    pub(crate) last_attempt_at: i64,
    pub(crate) access_expired: bool,
}

impl Database {
    /// Every stored label, in one read so the account list does not query per
    /// account. Keys with no row are simply absent.
    pub(crate) fn official_account_meta_index(&self) -> Result<AccountMetaIndex, AppError> {
        let conn = lock_conn!(self.conn);
        let mut metas = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT account_key, tags, group_id, note, disabled, disabled_at, \
                     disabled_reason, last_used_at FROM official_account_meta",
                )
                .map_err(|e| AppError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                })
                .map_err(|e| AppError::Database(e.to_string()))?;
            for row in rows {
                let (
                    key,
                    tags,
                    group_id,
                    note,
                    disabled,
                    disabled_at,
                    disabled_reason,
                    last_used_at,
                ) = row.map_err(|e| AppError::Database(e.to_string()))?;
                metas.insert(
                    key,
                    AccountMeta {
                        // Tags are written normalized, but a hand-edited or
                        // synced database must never fail the whole list.
                        tags: serde_json::from_str(&tags).unwrap_or_default(),
                        group_id,
                        note,
                        disabled: disabled.map(|value| value != 0).unwrap_or(false),
                        disabled_at,
                        disabled_reason,
                        last_used_at,
                    },
                );
            }
        }
        let mut groups = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, name, color, sort_index FROM official_account_groups")
                .map_err(|e| AppError::Database(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(AccountGroup {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                        sort_index: row.get(3)?,
                    })
                })
                .map_err(|e| AppError::Database(e.to_string()))?;
            for row in rows {
                let group = row.map_err(|e| AppError::Database(e.to_string()))?;
                groups.insert(group.id.clone(), group);
            }
        }
        Ok(AccountMetaIndex::new(metas, groups))
    }

    fn load_meta(conn: &rusqlite::Connection, key: &str) -> Result<Option<AccountMeta>, AppError> {
        let mut stmt = conn
            .prepare(
                "SELECT tags, group_id, note, disabled, disabled_at, disabled_reason, last_used_at \
                 FROM official_account_meta WHERE account_key = ?1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut rows = stmt
            .query(params![key])
            .map_err(|e| AppError::Database(e.to_string()))?;
        let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? else {
            return Ok(None);
        };
        let tags: String = row.get(0).map_err(|e| AppError::Database(e.to_string()))?;
        Ok(Some(AccountMeta {
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            group_id: row.get(1).map_err(|e| AppError::Database(e.to_string()))?,
            note: row.get(2).map_err(|e| AppError::Database(e.to_string()))?,
            disabled: row
                .get::<_, Option<i64>>(3)
                .map_err(|e| AppError::Database(e.to_string()))?
                .is_some_and(|value| value != 0),
            disabled_at: row.get(4).map_err(|e| AppError::Database(e.to_string()))?,
            disabled_reason: row.get(5).map_err(|e| AppError::Database(e.to_string()))?,
            last_used_at: row.get(6).map_err(|e| AppError::Database(e.to_string()))?,
        }))
    }

    /// One account's stored quota row; `None` when it was never queried.
    pub(crate) fn official_account_quota(
        &self,
        key: &str,
    ) -> Result<Option<OfficialQuotaRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT payload, fetched_at, last_attempt_at, access_expired \
                 FROM official_account_quota WHERE account_key = ?1",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut rows = stmt
            .query(params![key])
            .map_err(|e| AppError::Database(e.to_string()))?;
        let Some(row) = rows.next().map_err(|e| AppError::Database(e.to_string()))? else {
            return Ok(None);
        };
        Ok(Some(OfficialQuotaRow {
            payload: row.get(0).map_err(|e| AppError::Database(e.to_string()))?,
            fetched_at: row.get(1).map_err(|e| AppError::Database(e.to_string()))?,
            last_attempt_at: row.get(2).map_err(|e| AppError::Database(e.to_string()))?,
            access_expired: row
                .get::<_, Option<i64>>(3)
                .map_err(|e| AppError::Database(e.to_string()))?
                .is_some_and(|value| value != 0),
        }))
    }

    /// Every stored quota reading, in one read, for the account list.
    pub(crate) fn official_account_quota_index(
        &self,
    ) -> Result<HashMap<String, OfficialQuotaRow>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT account_key, payload, fetched_at, last_attempt_at, access_expired \
                 FROM official_account_quota",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut index = HashMap::new();
        for row in rows {
            let (key, payload, fetched_at, last_attempt_at, access_expired) =
                row.map_err(|e| AppError::Database(e.to_string()))?;
            index.insert(
                key,
                OfficialQuotaRow {
                    payload,
                    fetched_at,
                    last_attempt_at,
                    access_expired: access_expired.is_some_and(|value| value != 0),
                },
            );
        }
        Ok(index)
    }

    /// Stores one reading. Only a successful attempt moves `fetched_at`, so a
    /// failure cannot make an old good reading look fresh.
    pub(crate) fn store_official_account_quota(
        &self,
        key: &str,
        record: &OfficialQuotaRow,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO official_account_quota
                (account_key, payload, fetched_at, last_attempt_at, access_expired)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_key) DO UPDATE SET
                payload = excluded.payload,
                fetched_at = excluded.fetched_at,
                last_attempt_at = excluded.last_attempt_at,
                access_expired = excluded.access_expired",
            params![
                key,
                record.payload,
                record.fetched_at,
                record.last_attempt_at,
                i64::from(record.access_expired),
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Drops every stored field of an account that no longer exists.
    ///
    /// Called only after the credentials are gone: until then the account is
    /// still listed and its labels must survive.
    pub(crate) fn forget_official_account(&self, key: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM official_account_meta WHERE account_key = ?1",
            params![key],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        conn.execute(
            "DELETE FROM official_account_quota WHERE account_key = ?1",
            params![key],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Applies `patch` to one account's labels, adding the row when the account
    /// has never been labelled. Returns what was stored, so the caller can hand
    /// the normalized value back to the page.
    pub(crate) fn update_official_account_meta(
        &self,
        key: &str,
        now_ms: i64,
        patch: impl FnOnce(&mut AccountMeta),
    ) -> Result<AccountMeta, AppError> {
        let conn = lock_conn!(self.conn);
        let mut meta = Self::load_meta(&conn, key)?.unwrap_or_default();
        patch(&mut meta);
        let tags = serde_json::to_string(&meta.tags)
            .map_err(|e| AppError::Database(format!("序列化账号标签失败: {e}")))?;
        conn.execute(
            "INSERT INTO official_account_meta
                (account_key, tags, group_id, note, disabled, disabled_at, disabled_reason, \
                 last_used_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(account_key) DO UPDATE SET
                tags = excluded.tags,
                group_id = excluded.group_id,
                note = excluded.note,
                disabled = excluded.disabled,
                disabled_at = excluded.disabled_at,
                disabled_reason = excluded.disabled_reason,
                last_used_at = excluded.last_used_at,
                updated_at = excluded.updated_at",
            params![
                key,
                tags,
                meta.group_id,
                meta.note,
                i64::from(meta.disabled),
                meta.disabled_at,
                meta.disabled_reason,
                meta.last_used_at,
                now_ms,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(meta)
    }

    /// Records that an account was just used, skipping the write when the
    /// stored stamp is younger than `throttle_ms`.
    ///
    /// The account list calls this for the account Codex is running on, so the
    /// stamp tracks real use without the page having to tell us: a `WHERE` on
    /// the update branch keeps opening the page from rewriting the row, and
    /// with it from pinging auto-sync, on every refresh.
    pub(crate) fn touch_official_account_last_used(
        &self,
        key: &str,
        now_ms: i64,
        throttle_ms: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO official_account_meta
                (account_key, tags, last_used_at, created_at, updated_at)
             VALUES (?1, '[]', ?2, ?2, ?2)
             ON CONFLICT(account_key) DO UPDATE SET
                last_used_at = excluded.last_used_at,
                updated_at = excluded.updated_at
             WHERE official_account_meta.last_used_at IS NULL
                OR official_account_meta.last_used_at < ?3",
            params![key, now_ms, now_ms - throttle_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// The sort index a freshly created group goes after.
    pub(crate) fn next_official_account_group_sort_index(&self) -> Result<i64, AppError> {
        let conn = lock_conn!(self.conn);
        let next: Option<i64> = conn
            .query_row(
                "SELECT MAX(sort_index) + 1 FROM official_account_groups",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(next.unwrap_or(0))
    }

    pub(crate) fn create_official_account_group(
        &self,
        group: &AccountGroup,
        now_ms: i64,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT INTO official_account_groups
                (id, name, color, sort_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![group.id, group.name, group.color, group.sort_index, now_ms],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    /// Renames / recolors / reorders a group. Returns `false` when no group has
    /// that id, so the caller can report a stale page instead of pretending.
    pub(crate) fn update_official_account_group(
        &self,
        id: &str,
        name: &str,
        color: Option<&str>,
        sort_index: Option<i64>,
        now_ms: i64,
    ) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let changed = conn
            .execute(
                "UPDATE official_account_groups
                 SET name = ?2, color = ?3, sort_index = COALESCE(?4, sort_index), updated_at = ?5
                 WHERE id = ?1",
                params![id, name, color, sort_index, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(changed > 0)
    }

    /// Deletes a group and ungroups its accounts in one transaction, so a crash
    /// cannot leave accounts pointing at a group that no longer exists. Returns
    /// how many accounts were ungrouped.
    pub(crate) fn delete_official_account_group(
        &self,
        id: &str,
        now_ms: i64,
    ) -> Result<usize, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let ungrouped = tx
            .execute(
                "UPDATE official_account_meta SET group_id = NULL, updated_at = ?2
                 WHERE group_id = ?1",
                params![id, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let deleted = tx
            .execute(
                "DELETE FROM official_account_groups WHERE id = ?1",
                params![id],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if deleted == 0 {
            return Err(AppError::Message("分组不存在或已被删除".to_string()));
        }
        tx.commit()?;
        Ok(ungrouped)
    }

    /// Rewrites the group order from `ids`, first id first.
    pub(crate) fn reorder_official_account_groups(
        &self,
        ids: &[String],
        now_ms: i64,
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE official_account_groups SET sort_index = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, index as i64, now_ms],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        tx.commit()?;
        Ok(())
    }
}
