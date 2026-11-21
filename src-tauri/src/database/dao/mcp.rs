//! MCP 服务器数据访问对象
//!
//! 提供 MCP 服务器的 CRUD 操作。

use crate::app_config::{AppType, McpApps, McpServer};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use indexmap::IndexMap;
use rusqlite::{params, OptionalExtension};

const MCP_COLUMNS: &str = "id, name, server_config, description, homepage, docs, tags,
    enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode";

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
        let conn = lock_conn!(self.conn);
        let mut stmt = conn.prepare(&format!(
            "SELECT {MCP_COLUMNS} FROM mcp_servers ORDER BY name ASC, id ASC"
        ))?;
        let mut rows = stmt.query([])?;
        let mut servers = IndexMap::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            match decode_server(row, &id) {
                Ok(server) => {
                    servers.insert(id, server);
                }
                Err(error) => log::warn!("跳过无法读取的 MCP 服务器 {id}: {error}"),
            }
        }
        Ok(servers)
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
            AppType::Pi | AppType::ClaudeDesktop => {
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
        ];
        let conn = lock_conn!(self.conn);
        // Update in place so the v17 `notes` column survives a save; REPLACE
        // would delete the row and reset it.
        let updated = conn
            .execute(
                "UPDATE mcp_servers SET name = ?2, server_config = ?3, description = ?4,
                     homepage = ?5, docs = ?6, tags = ?7, enabled_claude = ?8, enabled_codex = ?9,
                     enabled_gemini = ?10, enabled_grokbuild = ?11, enabled_opencode = ?12
                 WHERE id = ?1",
                values,
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        if updated == 0 {
            conn.execute(
                "INSERT INTO mcp_servers (
                    id, name, server_config, description, homepage, docs, tags,
                    enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild, enabled_opencode
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                values,
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        }
        Ok(())
    }

    /// 删除 MCP 服务器
    pub fn delete_mcp_server(&self, id: &str) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }
}
