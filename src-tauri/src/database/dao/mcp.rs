//! MCP 服务器数据访问对象
//!
//! 提供 MCP 服务器的 CRUD 操作。

use super::{Rows, UnreadableEntry};
use crate::app_config::{AppType, McpApps, McpServer};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};

const MCP_COLUMNS: &str = "id, name, server_config, description, homepage, docs, tags,
    enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode,
    enabled_hermes, enabled_mcode, enabled_pi, enabled_agy, enabled_kimi, enabled_omp,
    enabled_dsh, enabled_copilot, enabled_workbuddy, enabled_codebuddy";

fn decode_server(row: &rusqlite::Row<'_>, id: &str) -> Result<McpServer, AppError> {
    let decode_error =
        |field: &str| AppError::Database(format!("MCP 服务器 {id} 的 {field} 无法读取"));
    let server: serde_json::Value = serde_json::from_str(
        row.get_ref(2)?
            .as_str()
            .map_err(|_| decode_error("server_config"))?,
    )
    .map_err(|_| decode_error("server_config"))?;
    if !server.is_object() {
        return Err(decode_error("server_config"));
    }
    let tags = serde_json::from_str(row.get_ref(6)?.as_str().map_err(|_| decode_error("tags"))?)
        .map_err(|_| decode_error("tags"))?;
    Ok(McpServer {
        id: id.to_string(),
        name: row.get(1)?,
        server,
        apps: McpApps {
            claude: row.get(7)?,
            codex: row.get(8)?,
            gemini: row.get(9)?,
            grokbuild: row.get(10)?,
            opencode: row.get(11)?,
            hermes: row.get(12)?,
            mcode: row.get(13)?,
            pi: row.get(14)?,
            agy: row.get(15)?,
            kimi: row.get(16)?,
            omp: row.get(17)?,
            dsh: row.get(18)?,
            copilot: row.get(19)?,
            workbuddy: row.get(20)?,
            codebuddy: row.get(21)?,
        },
        description: row.get(3)?,
        homepage: row.get(4)?,
        docs: row.get(5)?,
        tags,
    })
}

impl Database {
    /// Unreadable rows are reported individually and left in place.
    pub fn get_all_mcp_servers(&self) -> Result<IndexMap<String, McpServer>, AppError> {
        Ok(self
            .get_mcp_server_rows()?
            .into_readable("读取 MCP 服务器列表"))
    }

    pub fn get_mcp_server_rows(&self) -> Result<Rows<McpServer>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(&format!(
            "SELECT {MCP_COLUMNS} FROM mcp_servers ORDER BY name ASC, id ASC"
        ))?;
        let mut rows = stmt.query([])?;
        let mut out = Rows {
            readable: IndexMap::new(),
            unreadable: Vec::new(),
        };
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let name: String = row.get(1).unwrap_or_default();
            match decode_server(row, &id) {
                Ok(server) => {
                    out.readable.insert(id, server);
                }
                Err(error) => {
                    out.unreadable.push(UnreadableEntry {
                        id,
                        name,
                        error: error.to_string(),
                    });
                }
            }
        }
        Ok(out)
    }

    /// A targeted edit must distinguish an unreadable row from a missing row.
    pub(crate) fn get_mcp_server(&self, id: &str) -> Result<Option<McpServer>, AppError> {
        let conn = lock_conn!(self.conn);
        conn.query_row(
            &format!("SELECT {MCP_COLUMNS} FROM mcp_servers WHERE id = ?1"),
            [id],
            |row| Ok(decode_server(row, id)),
        )
        .optional()?
        .transpose()
    }

    /// Update just this app's switch and, for Codex, its optional soft-disable flag.
    pub(crate) fn update_mcp_toggle(
        &self,
        before: &McpServer,
        after: &McpServer,
        app: &AppType,
    ) -> Result<(), AppError> {
        let column = match app {
            AppType::Claude => "enabled_claude",
            AppType::Codex => "enabled_codex",
            AppType::Gemini => "enabled_gemini",
            AppType::GrokBuild => "enabled_grokbuild",
            AppType::OpenCode => "enabled_opencode",
            AppType::Hermes => "enabled_hermes",
            AppType::Mcode => "enabled_mcode",
            AppType::Pi => "enabled_pi",
            AppType::Agy => "enabled_agy",
            AppType::Kimi => "enabled_kimi",
            AppType::Omp => "enabled_omp",
            AppType::Dsh => "enabled_dsh",
            AppType::Copilot => "enabled_copilot",
            AppType::WorkBuddy => "enabled_workbuddy",
            AppType::Codebuddy => "enabled_codebuddy",
            AppType::OpenClaw | AppType::ClaudeDesktop => {
                return Err(AppError::InvalidInput(format!(
                    "{} does not use the shared MCP registry",
                    app.as_str()
                )));
            }
        };
        let config = (before.server != after.server)
            .then(|| serde_json::to_string(&after.server))
            .transpose()
            .map_err(|source| AppError::JsonSerialize { source })?;
        let conn = lock_conn!(self.conn);
        let updated = conn.execute(
            &format!("UPDATE mcp_servers SET {column} = ?2, server_config = COALESCE(?3, server_config) WHERE id = ?1"),
            params![before.id, after.apps.is_enabled_for(app), config],
        )?;
        if updated == 0 {
            return Err(AppError::Conflict(format!(
                "MCP 服务器 {} 已被删除",
                before.id
            )));
        }
        Ok(())
    }

    /// 保存 MCP 服务器
    pub fn save_mcp_server(&self, server: &McpServer) -> Result<(), AppError> {
        let server_config = serde_json::to_string(&server.server)
            .map_err(|e| AppError::Database(format!("Failed to serialize server config: {e}")))?;
        let tags = serde_json::to_string(&server.tags)
            .map_err(|e| AppError::Database(format!("Failed to serialize tags: {e}")))?;
        let values = params![
            server.id,
            server.name,
            server_config,
            server.description,
            server.homepage,
            server.docs,
            tags,
            server.apps.claude,
            server.apps.codex,
            server.apps.gemini,
            server.apps.grokbuild,
            server.apps.opencode,
            server.apps.hermes,
            server.apps.mcode,
            server.apps.pi,
            server.apps.agy,
            server.apps.kimi,
            server.apps.omp,
            server.apps.dsh,
            server.apps.copilot,
            server.apps.workbuddy,
            server.apps.codebuddy,
        ];
        let conn = lock_conn!(self.conn);
        // Update in place so the v17 `notes` column survives a save; REPLACE
        // would delete the row and reset it.
        let updated = conn
            .execute(
                "UPDATE mcp_servers SET name = ?2, server_config = ?3, description = ?4,
                     homepage = ?5, docs = ?6, tags = ?7, enabled_claude = ?8, enabled_codex = ?9,
                     enabled_gemini = ?10, enabled_grokbuild = ?11, enabled_opencode = ?12,
                     enabled_hermes = ?13, enabled_mcode = ?14, enabled_pi = ?15, enabled_agy = ?16,
                     enabled_kimi = ?17, enabled_omp = ?18, enabled_dsh = ?19, enabled_copilot = ?20,
                     enabled_workbuddy = ?21, enabled_codebuddy = ?22
                 WHERE id = ?1",
                values,
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated == 0 {
            conn.execute(
                "INSERT INTO mcp_servers (
                    id, name, server_config, description, homepage, docs, tags,
                    enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode,
                    enabled_hermes, enabled_mcode, enabled_pi, enabled_agy, enabled_kimi, enabled_omp,
                    enabled_dsh, enabled_copilot, enabled_workbuddy, enabled_codebuddy
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                values,
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    /// 更新指定 MCP 服务器在某个应用上的启用状态
    #[allow(dead_code)]
    pub fn update_mcp_server_app_enabled(
        &self,
        id: &str,
        app: &crate::app_config::AppType,
        enabled: bool,
    ) -> Result<(), AppError> {
        let Some(mut server) = self.get_all_mcp_servers()?.shift_remove(id) else {
            return Ok(());
        };
        server.apps.set_enabled_for(app, enabled);
        self.save_mcp_server(&server)
    }

    /// Return IDs of MCP servers enabled for the given app (ignoring malformed JSON).
    pub fn mcp_server_ids_enabled_for(
        &self,
        app: &crate::app_config::AppType,
    ) -> Result<std::collections::HashSet<String>, AppError> {
        let Some(col) = (match app {
            crate::app_config::AppType::Claude => Some("enabled_claude"),
            crate::app_config::AppType::Codex => Some("enabled_codex"),
            crate::app_config::AppType::Gemini => Some("enabled_gemini"),
            crate::app_config::AppType::GrokBuild => Some("enabled_grokbuild"),
            crate::app_config::AppType::OpenCode => Some("enabled_opencode"),
            crate::app_config::AppType::Hermes => Some("enabled_hermes"),
            crate::app_config::AppType::Mcode => Some("enabled_mcode"),
            crate::app_config::AppType::Pi => Some("enabled_pi"),
            crate::app_config::AppType::Agy => Some("enabled_agy"),
            crate::app_config::AppType::Kimi => Some("enabled_kimi"),
            crate::app_config::AppType::Omp => Some("enabled_omp"),
            crate::app_config::AppType::Dsh => Some("enabled_dsh"),
            crate::app_config::AppType::Copilot => Some("enabled_copilot"),
            crate::app_config::AppType::WorkBuddy => Some("enabled_workbuddy"),
            crate::app_config::AppType::Codebuddy => Some("enabled_codebuddy"),
            crate::app_config::AppType::ClaudeDesktop | crate::app_config::AppType::OpenClaw => {
                None
            }
        }) else {
            return Ok(std::collections::HashSet::new());
        };
        let conn = lock_conn!(self.conn);
        let sql = format!("SELECT id FROM mcp_servers WHERE {col} != 0");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            ids.insert(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(ids)
    }

    /// 删除 MCP 服务器
    pub fn delete_mcp_server(&self, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }
}
