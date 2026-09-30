//! Skills 服务层
//!
//! v3.10.0+ 统一管理架构：
//! - SSOT（单一事实源）：`~/.cc-switch/skills/`
//! - 安装时下载到 SSOT，按需同步到各应用目录
//! - 数据库存储安装记录和启用状态

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::timeout;

use crate::app_config::{AppType, InstalledSkill, SkillApps, UnmanagedSkill};
use crate::config::get_app_config_dir;
use crate::database::Database;
use crate::error::format_skill_error;

const MAX_SKILL_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SKILL_SINGLE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SKILL_ARCHIVE_ENTRIES: usize = 2048;
const MAX_SKILL_FILES: usize = 2048;
const MAX_SKILL_SYMLINKS: usize = 256;
const MAX_SKILL_PATH_BYTES: usize = 4096;
const MAX_SKILL_COMPRESSION_RATIO: u64 = 1000;
const MAX_SKILL_DIRECTORY_DEPTH: usize = 32;
const MAX_SKILL_DIRECTORIES: usize = 4096;
const MAX_DISCOVERED_SKILLS: usize = 2048;
const HASH_READ_BUFFER_BYTES: usize = 64 * 1024;
const SKILL_PROJECTION_MARKER: &str = ".chimera-managed-skill";
const SKILL_PROJECTION_MARKER_CONTENT: &[u8] = b"chimera++ managed skill projection v1\n";

#[derive(Debug, Default)]
struct HashBudget {
    files: usize,
    directories: usize,
    total_bytes: u64,
}

impl HashBudget {
    fn reserve_directory(&mut self, path: &Path, depth: usize) -> Result<()> {
        if depth > MAX_SKILL_DIRECTORY_DEPTH {
            return Err(anyhow!(
                "Skill 目录递归深度超过限制（最多 {} 层）: {}",
                MAX_SKILL_DIRECTORY_DEPTH,
                path.display()
            ));
        }
        self.directories = self
            .directories
            .checked_add(1)
            .ok_or_else(|| anyhow!("Skill 目录数量溢出"))?;
        if self.directories > MAX_SKILL_DIRECTORIES {
            return Err(anyhow!(
                "Skill 目录数量超过限制（最多 {} 个）: {}",
                MAX_SKILL_DIRECTORIES,
                path.display()
            ));
        }
        if path.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
            return Err(anyhow!("Skill 路径过长: {}", path.display()));
        }
        Ok(())
    }

    fn reserve_file(&mut self, path: &Path, declared_size: u64) -> Result<()> {
        self.files = self
            .files
            .checked_add(1)
            .ok_or_else(|| anyhow!("Skill 文件数量溢出"))?;
        if self.files > MAX_SKILL_FILES {
            return Err(anyhow!(
                "Skill 文件数量超过限制（最多 {} 个）: {}",
                MAX_SKILL_FILES,
                path.display()
            ));
        }
        if declared_size > MAX_SKILL_SINGLE_FILE_BYTES {
            return Err(anyhow!(
                "Skill 单文件超过限制（最多 {} MiB）: {}",
                MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                path.display()
            ));
        }
        if path.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
            return Err(anyhow!("Skill 路径过长: {}", path.display()));
        }
        Ok(())
    }

    fn add_bytes(&mut self, path: &Path, file_bytes: &mut u64, bytes: usize) -> Result<()> {
        let bytes = u64::try_from(bytes).map_err(|_| anyhow!("Skill 文件大小溢出"))?;
        *file_bytes = (*file_bytes)
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("Skill 单文件大小溢出"))?;
        if *file_bytes > MAX_SKILL_SINGLE_FILE_BYTES {
            return Err(anyhow!(
                "Skill 单文件超过限制（最多 {} MiB）: {}",
                MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                path.display()
            ));
        }
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("Skill 总大小溢出"))?;
        if self.total_bytes > MAX_SKILL_TOTAL_BYTES {
            return Err(anyhow!(
                "Skill 总大小超过限制（最多 {} MiB）",
                MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
struct CopyBudget {
    files: usize,
    directories: usize,
    bytes: u64,
}

impl CopyBudget {
    fn reserve_directory(&mut self, path: &Path, depth: usize) -> Result<()> {
        if depth > MAX_SKILL_DIRECTORY_DEPTH {
            return Err(anyhow!(
                "Skill 目录复制递归深度超过限制（最多 {} 层）: {}",
                MAX_SKILL_DIRECTORY_DEPTH,
                path.display()
            ));
        }
        self.directories = self
            .directories
            .checked_add(1)
            .ok_or_else(|| anyhow!("Skill 目录复制数量溢出"))?;
        if self.directories > MAX_SKILL_DIRECTORIES {
            return Err(anyhow!(
                "Skill 目录复制数量超过限制（最多 {} 个）: {}",
                MAX_SKILL_DIRECTORIES,
                path.display()
            ));
        }
        Ok(())
    }

    fn reserve(&mut self, path: &Path, bytes: u64) -> Result<()> {
        self.files = self
            .files
            .checked_add(1)
            .ok_or_else(|| anyhow!("Skill 文件数量溢出"))?;
        if self.files > MAX_SKILL_FILES {
            return Err(anyhow!(
                "Skill 文件数量超过限制（最多 {} 个）: {}",
                MAX_SKILL_FILES,
                path.display()
            ));
        }
        if bytes > MAX_SKILL_SINGLE_FILE_BYTES {
            return Err(anyhow!(
                "Skill 单文件超过限制（最多 {} MiB）: {}",
                MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                path.display()
            ));
        }
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("Skill 解压总大小溢出"))?;
        if self.bytes > MAX_SKILL_TOTAL_BYTES {
            return Err(anyhow!(
                "Skill 解压总大小超过限制（最多 {} MiB）",
                MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }
}

// ========== 数据结构 ==========

/// Skill 同步方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SyncMethod {
    /// 自动选择：优先 symlink，失败时回退到 copy
    #[default]
    Auto,
    /// 符号链接（推荐，节省磁盘空间）
    Symlink,
    /// 文件复制（兼容模式）
    Copy,
}

/// Skill 存储位置（SSOT 目录选择）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SkillStorageLocation {
    /// CC Switch 管理目录 (~/.cc-switch/skills/)
    #[default]
    CcSwitch,
    /// Agent Skills 统一标准目录 (~/.agents/skills/)
    Unified,
}

/// 可发现的技能（来自仓库）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoverableSkill {
    /// 唯一标识: "owner/name:directory"
    pub key: String,
    /// 显示名称 (从 SKILL.md 解析)
    pub name: String,
    /// 技能描述
    pub description: String,
    /// 目录名称 (安装路径的最后一段)
    pub directory: String,
    /// GitHub README URL
    #[serde(rename = "readmeUrl")]
    pub readme_url: Option<String>,
    /// 仓库所有者
    #[serde(rename = "repoOwner")]
    pub repo_owner: String,
    /// 仓库名称
    #[serde(rename = "repoName")]
    pub repo_name: String,
    /// 分支名称
    #[serde(rename = "repoBranch")]
    pub repo_branch: String,
}

/// 技能对象（兼容旧 API，内部使用 DiscoverableSkill）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    /// 唯一标识: "owner/name:directory" 或 "local:directory"
    pub key: String,
    /// 显示名称 (从 SKILL.md 解析)
    pub name: String,
    /// 技能描述
    pub description: String,
    /// 目录名称 (安装路径的最后一段)
    pub directory: String,
    /// GitHub README URL
    #[serde(rename = "readmeUrl")]
    pub readme_url: Option<String>,
    /// 是否已安装
    pub installed: bool,
    /// 仓库所有者
    #[serde(rename = "repoOwner")]
    pub repo_owner: Option<String>,
    /// 仓库名称
    #[serde(rename = "repoName")]
    pub repo_name: Option<String>,
    /// 分支名称
    #[serde(rename = "repoBranch")]
    pub repo_branch: Option<String>,
}

/// 仓库配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRepo {
    /// GitHub 用户/组织名
    pub owner: String,
    /// 仓库名称
    pub name: String,
    /// 分支 (默认 "main")
    pub branch: String,
    /// 是否启用
    pub enabled: bool,
}

/// 技能安装状态（旧版兼容）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillState {
    /// 是否已安装
    pub installed: bool,
    /// 安装时间
    #[serde(rename = "installedAt")]
    pub installed_at: DateTime<Utc>,
}

/// 持久化存储结构（仓库配置）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillStore {
    /// directory -> 安装状态（旧版兼容，新版不使用）
    pub skills: HashMap<String, SkillState>,
    /// 仓库列表
    pub repos: Vec<SkillRepo>,
}

impl Default for SkillStore {
    fn default() -> Self {
        SkillStore {
            skills: HashMap::new(),
            repos: vec![
                SkillRepo {
                    owner: "anthropics".to_string(),
                    name: "skills".to_string(),
                    branch: "main".to_string(),
                    enabled: true,
                },
                SkillRepo {
                    owner: "ComposioHQ".to_string(),
                    name: "awesome-claude-skills".to_string(),
                    branch: "master".to_string(),
                    enabled: true,
                },
                SkillRepo {
                    owner: "cexll".to_string(),
                    name: "myclaude".to_string(),
                    branch: "master".to_string(),
                    enabled: true,
                },
                SkillRepo {
                    owner: "JimLiu".to_string(),
                    name: "baoyu-skills".to_string(),
                    branch: "main".to_string(),
                    enabled: true,
                },
            ],
        }
    }
}

/// Skill 卸载结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUninstallResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Skill 更新检测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateInfo {
    /// Skill ID
    pub id: String,
    /// Skill 名称
    pub name: String,
    /// 当前本地哈希
    pub current_hash: Option<String>,
    /// 远程最新哈希
    pub remote_hash: String,
}

/// Skill 存储位置迁移结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub migrated_count: usize,
    pub skipped_count: usize,
    pub errors: Vec<String>,
}

// ========== skills.sh API 类型 ==========

/// skills.sh API 原始响应
///
/// 注意：API 命名不一致（searchType 是 camelCase，duration_ms 是 snake_case），
/// 因此不能用 rename_all，需要逐字段指定。
#[derive(Debug, Clone, Deserialize)]
struct SkillsShApiResponse {
    pub query: String,
    #[serde(rename = "searchType")]
    #[allow(dead_code)]
    pub search_type: String,
    pub skills: Vec<SkillsShApiSkill>,
    pub count: usize,
    #[allow(dead_code)]
    pub duration_ms: u64,
}

/// skills.sh API 原始技能条目
#[derive(Debug, Clone, Deserialize)]
struct SkillsShApiSkill {
    pub id: String,
    #[serde(rename = "skillId")]
    pub skill_id: String,
    pub name: String,
    pub installs: u64,
    pub source: String,
}

/// skills.sh 搜索结果（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsShSearchResult {
    pub skills: Vec<SkillsShDiscoverableSkill>,
    pub total_count: usize,
    pub query: String,
}

/// skills.sh 可安装技能（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsShDiscoverableSkill {
    pub key: String,
    pub name: String,
    pub directory: String,
    pub repo_owner: String,
    pub repo_name: String,
    pub repo_branch: String,
    pub installs: u64,
    pub readme_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBackupEntry {
    pub backup_id: String,
    pub backup_path: String,
    pub created_at: i64,
    pub skill: InstalledSkill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillBackupMetadata {
    skill: InstalledSkill,
    backup_created_at: i64,
    source_path: String,
}

const SKILL_BACKUP_RETAIN_COUNT: usize = 20;

/// 技能元数据 (从 SKILL.md 解析)
#[derive(Debug, Clone, Deserialize)]
pub struct SkillMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// 导入已有 Skill 时，前端显式提交的启用应用选择
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillSelection {
    pub directory: String,
    #[serde(default)]
    pub apps: SkillApps,
}

#[derive(Debug, Clone, Deserialize)]
struct LegacySkillMigrationRow {
    directory: String,
    app_type: String,
}

// ========== ~/.agents/ lock 文件解析 ==========

/// `~/.agents/.skill-lock.json` 文件结构
#[derive(Deserialize)]
struct AgentsLockFile {
    skills: HashMap<String, AgentsLockSkill>,
}

/// lock 文件中单个 skill 的信息
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsLockSkill {
    source: Option<String>,
    source_type: Option<String>,
    source_url: Option<String>,
    skill_path: Option<String>,
    branch: Option<String>,
    source_branch: Option<String>,
}

#[derive(Debug, Clone)]
struct LockRepoInfo {
    owner: String,
    repo: String,
    skill_path: Option<String>,
    branch: Option<String>,
}

fn normalize_optional_branch(branch: Option<String>) -> Option<String> {
    branch.and_then(|b| {
        let trimmed = b.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_branch_from_source_url(source_url: Option<&str>) -> Option<String> {
    let source_url = source_url?;
    let source_url = source_url.trim();
    if source_url.is_empty() {
        return None;
    }

    // 支持 https://github.com/owner/repo/tree/<branch>/...
    if let Some((_, after_tree)) = source_url.split_once("/tree/") {
        let branch = after_tree
            .split('/')
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        return Some(branch.to_string());
    }

    // 支持 URL fragment: ...git#branch
    if let Some((_, fragment)) = source_url.split_once('#') {
        let branch = fragment
            .split('&')
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        return Some(branch.to_string());
    }

    // 支持 query: ...?branch=xxx / ?ref=xxx
    if let Some((_, query)) = source_url.split_once('?') {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            if matches!(key, "branch" | "ref") {
                let branch = value.trim();
                if !branch.is_empty() {
                    return Some(branch.to_string());
                }
            }
        }
    }

    None
}

/// 获取 `~/.agents/skills/` 目录（存在时返回）。
///
/// 路径检查失败必须向上传播，不能把“不安全/不可读”降级成“目录不存在”。
fn get_agents_skills_dir() -> Result<Option<PathBuf>> {
    let dir = crate::config::get_home_dir().join(".agents").join("skills");
    if SkillService::normal_directory_exists(&dir)? {
        Ok(Some(dir))
    } else {
        Ok(None)
    }
}

/// 解析 `~/.agents/.skill-lock.json`，返回 skill_name -> 仓库信息
fn parse_agents_lock() -> HashMap<String, LockRepoInfo> {
    let path = crate::config::get_home_dir()
        .join(".agents")
        .join(".skill-lock.json");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                log::debug!("未找到 agents lock 文件: {}", path.display());
            } else {
                log::warn!("读取 agents lock 文件失败 ({}): {}", path.display(), e);
            }
            return HashMap::new();
        }
    };
    let lock: AgentsLockFile = match serde_json::from_str(&content) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("解析 agents lock 文件失败 ({}): {}", path.display(), e);
            return HashMap::new();
        }
    };
    let parsed: HashMap<String, LockRepoInfo> = lock
        .skills
        .into_iter()
        .filter_map(|(name, skill)| {
            let source = skill.source?;
            if skill.source_type.as_deref() != Some("github") {
                return None;
            }
            let (owner, repo) = source.split_once('/')?;
            let branch = normalize_optional_branch(skill.branch)
                .or_else(|| normalize_optional_branch(skill.source_branch))
                .or_else(|| parse_branch_from_source_url(skill.source_url.as_deref()));
            Some((
                name,
                LockRepoInfo {
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    skill_path: skill.skill_path,
                    branch,
                },
            ))
        })
        .collect();
    log::info!(
        "agents lock 文件解析完成，共识别 {} 个 github skill",
        parsed.len()
    );
    parsed
}

// ========== SkillService ==========

pub struct SkillService;

struct PreparedZipSkill {
    source: PathBuf,
    install_name: String,
    name: String,
    description: Option<String>,
}

impl Default for SkillService {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillService {
    pub fn new() -> Self {
        Self
    }

    /// 构建 Skill 文档 URL（指向仓库中的 SKILL.md 文件）
    fn build_skill_doc_url(owner: &str, repo: &str, branch: &str, doc_path: &str) -> String {
        format!("https://github.com/{owner}/{repo}/blob/{branch}/{doc_path}")
    }

    /// 从旧 readme_url 中提取仓库内文档路径，兼容 `blob`/`tree` 两种格式
    fn extract_doc_path_from_url(url: &str) -> Option<String> {
        let marker = if url.contains("/blob/") {
            "/blob/"
        } else if url.contains("/tree/") {
            "/tree/"
        } else {
            return None;
        };

        let (_, tail) = url.split_once(marker)?;
        let (_, path) = tail.split_once('/')?;
        if path.is_empty() {
            return None;
        }
        Some(path.to_string())
    }

    // ========== 路径管理 ==========

    /// 获取 SSOT 目录（根据设置返回 ~/.cc-switch/skills/ 或 ~/.agents/skills/）
    pub fn get_ssot_dir() -> Result<PathBuf> {
        let location = crate::settings::get_skill_storage_location();
        let dir = match location {
            SkillStorageLocation::CcSwitch => get_app_config_dir().join("skills"),
            SkillStorageLocation::Unified => {
                crate::config::get_home_dir().join(".agents").join("skills")
            }
        };
        Self::ensure_normal_directory(&dir)?;
        Ok(dir)
    }

    /// 获取 Skill 卸载备份目录（~/.cc-switch/skill-backups/）
    fn get_backup_dir() -> Result<PathBuf> {
        let dir = get_app_config_dir().join("skill-backups");
        Self::ensure_normal_directory(&dir)?;
        Ok(dir)
    }

    /// 获取应用的 skills 目录
    pub fn get_app_skills_dir(app: &AppType) -> Result<PathBuf> {
        // 目录覆盖：优先使用用户在 settings.json 中配置的 override 目录
        match app {
            AppType::Claude => {
                if let Some(custom) = crate::settings::get_claude_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::ClaudeDesktop => {}
            AppType::Codex => {
                if let Some(custom) = crate::settings::get_codex_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::Gemini => {
                if let Some(custom) = crate::settings::get_gemini_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::GrokBuild => {
                if let Some(custom) = crate::settings::get_grok_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::OpenCode => {
                if let Some(custom) = crate::settings::get_opencode_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::OpenClaw => {
                if let Some(custom) = crate::settings::get_openclaw_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::Hermes => {
                if let Some(custom) = crate::settings::get_hermes_override_dir() {
                    return Ok(custom.join("skills"));
                }
            }
            AppType::Pi => {}
        }

        // 默认路径：回退到用户主目录下的标准位置。
        // 必须走 get_home_dir()（可被 CC_SWITCH_TEST_HOME 覆盖）：Windows 上 dirs::home_dir()
        // 走 Known Folder API，测试无法隔离真实用户目录。
        let home = crate::config::get_home_dir();

        Ok(match app {
            AppType::Claude => home.join(".claude").join("skills"),
            AppType::ClaudeDesktop => home.join(".claude-desktop").join("skills"),
            AppType::Codex => home.join(".codex").join("skills"),
            AppType::Gemini => home.join(".gemini").join("skills"),
            AppType::GrokBuild => home.join(".grok").join("skills"),
            AppType::OpenCode => home.join(".config").join("opencode").join("skills"),
            AppType::OpenClaw => home.join(".openclaw").join("skills"),
            AppType::Hermes => crate::hermes_config::get_hermes_dir().join("skills"),
            // Only ever scanned: Skills are never synced into or removed from
            // Pi in this release (see `sync_to_app` / `remove_from_app`).
            AppType::Pi => home.join(".pi").join("agent").join("skills"),
        })
    }

    // ========== 统一管理方法 ==========

    /// 获取所有已安装的 Skills
    pub fn get_all_installed(db: &Arc<Database>) -> Result<Vec<InstalledSkill>> {
        let skills = db.get_all_installed_skills()?;
        Ok(skills.into_values().collect())
    }

    /// 安装 Skill
    ///
    /// 流程：
    /// 1. 下载到 SSOT 目录
    /// 2. 保存到数据库
    /// 3. 同步到启用的应用目录
    pub async fn install(
        &self,
        db: &Arc<Database>,
        skill: &DiscoverableSkill,
        current_app: &AppType,
    ) -> Result<InstalledSkill> {
        let ssot_dir = Self::get_ssot_dir()?;

        // 允许多级目录（如 a/b/c），但必须是安全的相对路径。
        let source_rel = Self::sanitize_skill_source_path(&skill.directory).ok_or_else(|| {
            anyhow!(format_skill_error(
                "INVALID_SKILL_DIRECTORY",
                &[("directory", &skill.directory)],
                Some("checkZipContent"),
            ))
        })?;
        // 安装目录名始终使用最后一段，避免在 SSOT 中创建多级目录。
        let install_name = source_rel
            .file_name()
            .and_then(|name| Self::sanitize_install_name(&name.to_string_lossy()))
            .ok_or_else(|| {
                anyhow!(format_skill_error(
                    "INVALID_SKILL_DIRECTORY",
                    &[("directory", &skill.directory)],
                    Some("checkZipContent"),
                ))
            })?;

        // 检查数据库中是否已有同名 directory 的 skill（来自其他仓库）
        let existing_skills = db.get_all_installed_skills()?;
        for existing in existing_skills.values() {
            if existing.directory.eq_ignore_ascii_case(&install_name) {
                // 检查是否来自同一仓库
                let same_repo = existing.repo_owner.as_deref() == Some(&skill.repo_owner)
                    && existing.repo_name.as_deref() == Some(&skill.repo_name);
                if same_repo {
                    // 同一仓库的同名 skill，返回现有记录（可能需要更新启用状态）
                    let mut updated = existing.clone();
                    updated.apps.set_enabled_for(current_app, true);
                    db.save_skill(&updated)?;
                    Self::sync_managed_to_app_dir(&updated.directory, current_app)?;
                    log::info!(
                        "Skill {} 已存在，更新 {:?} 启用状态",
                        updated.name,
                        current_app
                    );
                    return Ok(updated);
                } else {
                    // 不同仓库的同名 skill，报错
                    return Err(anyhow!(format_skill_error(
                        "SKILL_DIRECTORY_CONFLICT",
                        &[
                            ("directory", &install_name),
                            (
                                "existing_repo",
                                &format!(
                                    "{}/{}",
                                    existing.repo_owner.as_deref().unwrap_or("unknown"),
                                    existing.repo_name.as_deref().unwrap_or("unknown")
                                )
                            ),
                            (
                                "new_repo",
                                &format!("{}/{}", skill.repo_owner, skill.repo_name)
                            ),
                        ],
                        Some("uninstallFirst"),
                    )));
                }
            }
        }

        let dest = ssot_dir.join(&install_name);

        // 数据库中没有同名记录时，SSOT 中已有目录只能视为未管理内容，
        // 不得被远程安装流程静默接管或覆盖。
        match fs::symlink_metadata(&dest) {
            Ok(_) => {
                return Err(anyhow!(
                    "Skill 目标目录已存在但没有对应数据库记录，拒绝接管: {}",
                    dest.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 目标目录失败: {}", dest.display()))
            }
        }

        let repo_branch = {
            let repo = SkillRepo {
                owner: skill.repo_owner.clone(),
                name: skill.repo_name.clone(),
                branch: skill.repo_branch.clone(),
                enabled: true,
            };

            // 下载仓库
            let (temp_dir, used_branch) = timeout(
                std::time::Duration::from_secs(60),
                self.download_repo(&repo),
            )
            .await
            .map_err(|_| {
                anyhow!(format_skill_error(
                    "DOWNLOAD_TIMEOUT",
                    &[
                        ("owner", &repo.owner),
                        ("name", &repo.name),
                        ("timeout", "60")
                    ],
                    Some("checkNetwork"),
                ))
            })??;
            let repo_branch = used_branch;

            // 复制到 SSOT
            let source = match Self::resolve_skill_source_dir_checked(&temp_dir, &skill.directory) {
                Ok(Some(source)) => source,
                Ok(None) => {
                    let missing = temp_dir.join(&source_rel).display().to_string();
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "{} (temp_cleanup={cleanup_error:?})",
                        format_skill_error(
                            "SKILL_DIR_NOT_FOUND",
                            &[("path", &missing)],
                            Some("checkRepoUrl"),
                        )
                    ));
                }
                Err(error) => {
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "解析远程 Skill 源目录失败（temp_cleanup={cleanup_error:?}）: {error:#}"
                    ));
                }
            };

            let canonical_temp = temp_dir.canonicalize().unwrap_or_else(|_| temp_dir.clone());
            let canonical_source = source.canonicalize().map_err(|_| {
                anyhow!(format_skill_error(
                    "SKILL_DIR_NOT_FOUND",
                    &[("path", &source.display().to_string())],
                    Some("checkRepoUrl"),
                ))
            })?;
            if !canonical_source.starts_with(&canonical_temp) || !canonical_source.is_dir() {
                let _ = Self::remove_path(&temp_dir);
                return Err(anyhow!(format_skill_error(
                    "INVALID_SKILL_DIRECTORY",
                    &[("directory", &skill.directory)],
                    Some("checkZipContent"),
                )));
            }

            let (staged, staging_root) =
                match Self::stage_directory_copy(&canonical_source, &ssot_dir, &install_name) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = Self::remove_path(&temp_dir);
                        return Err(error);
                    }
                };
            let commit_result = Self::commit_new_directory(&staged, &dest);
            let _ = Self::remove_path(&staging_root);
            let _ = Self::remove_path(&temp_dir);
            commit_result?;

            // 使用实际下载成功的分支，避免 readme_url / repo_branch 与真实分支不一致。
            if repo_branch != skill.repo_branch {
                log::info!(
                    "Skill {}/{} 分支自动回退: {} -> {}",
                    skill.repo_owner,
                    skill.repo_name,
                    skill.repo_branch,
                    repo_branch
                );
            }
            repo_branch
        };

        let doc_path = skill
            .readme_url
            .as_deref()
            .and_then(Self::extract_doc_path_from_url)
            .map(|path| {
                if path.ends_with("/SKILL.md") || path == "SKILL.md" {
                    path
                } else {
                    format!("{}/SKILL.md", path.trim_end_matches('/'))
                }
            })
            .unwrap_or_else(|| format!("{}/SKILL.md", skill.directory.trim_end_matches('/')));

        let readme_url = Some(Self::build_skill_doc_url(
            &skill.repo_owner,
            &skill.repo_name,
            &repo_branch,
            &doc_path,
        ));

        // 创建 InstalledSkill 记录
        // 计算内容哈希；失败时回滚 SSOT，不能用 None 掩盖目录损坏或越界。
        let content_hash = match Self::compute_dir_hash(&dest) {
            Ok(hash) => Some(hash),
            Err(error) => {
                let cleanup_error = Self::remove_path(&dest).err();
                return Err(anyhow!(
                    "安装 Skill 后计算内容哈希失败，已尝试清理 SSOT（cleanup={cleanup_error:?}）: {error}"
                ));
            }
        };

        let installed_skill = InstalledSkill {
            id: skill.key.clone(),
            name: skill.name.clone(),
            description: if skill.description.is_empty() {
                None
            } else {
                Some(skill.description.clone())
            },
            directory: install_name.clone(),
            repo_owner: Some(skill.repo_owner.clone()),
            repo_name: Some(skill.repo_name.clone()),
            repo_branch: Some(repo_branch),
            readme_url,
            apps: SkillApps::only(current_app),
            installed_at: chrono::Utc::now().timestamp(),
            content_hash,
            updated_at: 0,
        };

        // 先保存数据库；任一步失败都撤销本次新目录，避免 SSOT/DB 分裂。
        if let Err(error) = db.save_skill(&installed_skill) {
            let _ = Self::remove_path(&dest);
            return Err(error.into());
        }

        // 同步到当前应用目录；失败时尽力回滚数据库、SSOT 和当前应用投影。
        if let Err(error) = Self::sync_to_app_dir(&install_name, current_app) {
            let db_error = db.delete_skill(&installed_skill.id).err();
            let ssot_error = Self::remove_path(&dest).err();
            let app_error = Self::remove_from_app(&install_name, current_app).err();
            return Err(anyhow!(
                "Skill 同步失败，已回滚安装（db={:?}, ssot={:?}, app={:?}）: {}",
                db_error,
                ssot_error,
                app_error,
                error
            ));
        }

        log::info!(
            "Skill {} 安装成功，已启用 {:?}",
            installed_skill.name,
            current_app
        );

        Ok(installed_skill)
    }

    /// 卸载 Skill
    ///
    /// 流程：
    /// 1. 从所有应用目录删除
    /// 2. 从 SSOT 删除
    /// 3. 从数据库删除
    pub fn uninstall(db: &Arc<Database>, id: &str) -> Result<SkillUninstallResult> {
        // 获取 skill 信息
        let skill = db
            .get_installed_skill(id)?
            .ok_or_else(|| anyhow!("Skill not found: {id}"))?;
        Self::validate_managed_skill_directory(&skill.directory)?;

        // 先验证 SSOT 目标，再触碰任何应用投影。否则一个恶意 symlink/junction
        // 会导致应用投影已经删除、但 SSOT 校验才失败，形成半完成卸载。
        let ssot_dir = Self::get_ssot_dir()?;
        let skill_path = ssot_dir.join(&skill.directory);
        let ssot_present = match fs::symlink_metadata(&skill_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || Self::has_reparse_point(&metadata)
                    || !metadata.is_dir()
                {
                    return Err(anyhow!(
                        "SSOT Skill 不是普通目录，拒绝卸载以避免路径逃逸: {}",
                        skill_path.display()
                    ));
                }
                Self::validate_normal_directory_tree(&skill_path)?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 SSOT Skill 失败: {}", skill_path.display()))
            }
        };

        let backup_path = Self::create_uninstall_backup(&skill)?;
        let backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());

        // 从所有应用目录删除；不能吞掉错误，否则会出现数据库已删除但应用仍在使用旧文件。
        let mut removed_apps = Vec::new();
        for app in AppType::all() {
            if let Err(error) = Self::remove_from_app(&skill.directory, &app) {
                // 当前 app 也纳入恢复尝试：remove_dir_all 可能已经部分完成。
                removed_apps.push(app.clone());
                let rollback_errors = Self::restore_removed_app_projections(&skill, &removed_apps);
                return Err(anyhow!(
                    "从 {:?} 删除 Skill {} 失败，已尝试恢复应用投影（rollback={:?}）: {}",
                    app,
                    skill.directory,
                    rollback_errors,
                    error
                ));
            }
            removed_apps.push(app);
        }

        // 从 SSOT 删除；失败时 SSOT 仍在，直接从 SSOT 恢复已删除的应用投影。
        if ssot_present {
            if let Err(error) = Self::remove_path(&skill_path) {
                let rollback_errors = Self::restore_removed_app_projections(&skill, &removed_apps);
                return Err(anyhow!(
                    "删除 SSOT Skill {} 失败，已尝试恢复应用投影（rollback={:?}）: {}",
                    skill.directory,
                    rollback_errors,
                    error
                ));
            }
        }

        // 数据库删除失败时必须恢复 SSOT 和应用投影；否则 DB 仍声明已安装，
        // 但文件已经消失。备份是卸载前创建的独立恢复源，不依赖已删除的 SSOT。
        if let Err(error) = db.delete_skill(id) {
            let mut rollback_errors = Vec::new();
            if let Some(backup) = backup_path.as_deref() {
                if let Err(restore_error) =
                    Self::restore_skill_from_backup_to_ssot(backup, &skill_path)
                {
                    rollback_errors.push(format!("ssot: {restore_error}"));
                }
            } else if ssot_present {
                rollback_errors.push("ssot: 卸载备份不存在，无法恢复已删除的 SSOT".to_string());
            }
            rollback_errors.extend(
                Self::restore_removed_app_projections(&skill, &removed_apps)
                    .into_iter()
                    .map(|error| format!("app: {error}")),
            );
            return Err(anyhow!(
                "删除 Skill 数据库记录失败，已尝试恢复文件和应用投影（rollback={:?}）: {}",
                rollback_errors,
                error
            ));
        }

        log::info!(
            "Skill {} 卸载成功{}",
            skill.name,
            backup_path_string
                .as_deref()
                .map(|path| format!(", backup: {path}"))
                .unwrap_or_default()
        );

        Ok(SkillUninstallResult {
            backup_path: backup_path_string,
        })
    }

    // ========== 更新检测 ==========

    /// 计算目录内容的 SHA-256 哈希
    ///
    /// 递归遍历目录下所有非隐藏普通文件，按相对路径字典序排列，
    /// 将 "相对路径\0内容\0" 逐文件 feed 给同一个 hasher。读取过程使用
    /// 流式缓冲和统一资源预算，避免通过超大文件或符号链接耗尽内存/绕过目录边界。
    pub fn compute_dir_hash(dir: &Path) -> Result<String> {
        use sha2::{Digest, Sha256};

        let mut files: Vec<PathBuf> = Vec::new();
        let mut budget = HashBudget::default();
        Self::collect_files_for_hash(dir, &mut files, &mut budget, 0)?;
        files.sort();

        let mut hasher = Sha256::new();
        let mut buffer = [0u8; HASH_READ_BUFFER_BYTES];
        for file_path in &files {
            let relative = file_path.strip_prefix(dir).unwrap_or(file_path);
            let rel_str = relative.to_string_lossy().replace('\\', "/");
            hasher.update(rel_str.as_bytes());
            hasher.update(b"\0");

            let metadata = fs::symlink_metadata(file_path)
                .with_context(|| format!("读取文件失败: {}", file_path.display()))?;
            if metadata.file_type().is_symlink()
                || Self::has_reparse_point(&metadata)
                || !metadata.is_file()
            {
                return Err(anyhow!(
                    "Skill 哈希源在读取时变为非普通文件: {}",
                    file_path.display()
                ));
            }
            let mut file = fs::File::open(file_path)
                .with_context(|| format!("读取文件失败: {}", file_path.display()))?;
            let mut file_bytes = 0u64;
            loop {
                let read = file
                    .read(&mut buffer)
                    .with_context(|| format!("读取文件失败: {}", file_path.display()))?;
                if read == 0 {
                    break;
                }
                budget.add_bytes(file_path, &mut file_bytes, read)?;
                hasher.update(&buffer[..read]);
            }
            hasher.update(b"\0");
        }

        Ok(format!("{:x}", hasher.finalize()))
    }

    /// 递归收集目录下所有非隐藏普通文件，并拒绝符号链接和特殊文件。
    fn collect_files_for_hash(
        current: &Path,
        files: &mut Vec<PathBuf>,
        budget: &mut HashBudget,
        depth: usize,
    ) -> Result<()> {
        let current_metadata = fs::symlink_metadata(current)
            .with_context(|| format!("读取目录失败: {}", current.display()))?;
        if current_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&current_metadata)
            || !current_metadata.is_dir()
        {
            return Err(anyhow!("Skill 哈希源不是普通目录: {}", current.display()));
        }
        budget.reserve_directory(current, depth)?;

        let entries = fs::read_dir(current)
            .with_context(|| format!("读取目录失败: {}", current.display()))?;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("读取 Skill 条目失败: {}", path.display()))?;
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "Skill 哈希源包含符号链接或 junction: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                Self::collect_files_for_hash(&path, files, budget, depth + 1)?;
            } else if metadata.is_file() {
                budget.reserve_file(&path, metadata.len())?;
                files.push(path);
            } else {
                return Err(anyhow!(
                    "Skill 哈希源包含不支持的文件类型: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    /// 检查所有已安装 Skill 的更新
    ///
    /// 仅检查有 repo_owner 的 Skill（本地 Skill 跳过），
    /// 按仓库分组下载，避免重复下载同一仓库。
    pub async fn check_updates(&self, db: &Arc<Database>) -> Result<Vec<SkillUpdateInfo>> {
        let skills = db.get_all_installed_skills()?;
        let mut updates = Vec::new();

        // 按 (owner, name, branch) 分组
        let mut repo_groups: HashMap<(String, String, String), Vec<InstalledSkill>> =
            HashMap::new();

        for skill in skills.into_values() {
            if Self::validate_managed_skill_directory(&skill.directory).is_err() {
                log::warn!("跳过目录字段非法的 Skill 更新检查: {}", skill.id);
                continue;
            }
            let (owner, name, branch) =
                match (&skill.repo_owner, &skill.repo_name, &skill.repo_branch) {
                    (Some(o), Some(n), Some(b)) => (o.clone(), n.clone(), b.clone()),
                    (Some(o), Some(n), None) => (o.clone(), n.clone(), "main".to_string()),
                    _ => continue,
                };
            repo_groups
                .entry((owner, name, branch))
                .or_default()
                .push(skill);
        }

        let ssot_dir = Self::get_ssot_dir()?;

        for ((owner, name, branch), group_skills) in &repo_groups {
            let repo = SkillRepo {
                owner: owner.clone(),
                name: name.clone(),
                branch: branch.clone(),
                enabled: true,
            };

            // 下载仓库 ZIP
            let (temp_dir, _used_branch) = match timeout(
                std::time::Duration::from_secs(60),
                self.download_repo(&repo),
            )
            .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(e)) => {
                    log::warn!("检查更新时下载 {}/{} 失败: {e}", owner, name);
                    continue;
                }
                Err(_) => {
                    log::warn!("检查更新时下载 {}/{} 超时", owner, name);
                    continue;
                }
            };

            // 扫描仓库中的所有 Skill 目录
            let mut remote_skills: Vec<DiscoverableSkill> = Vec::new();
            if let Err(error) =
                self.scan_dir_recursive(&temp_dir, &temp_dir, &repo, &mut remote_skills)
            {
                log::warn!("扫描远程仓库 {}/{} 失败: {error:#}", owner, name);
                let _ = Self::remove_path(&temp_dir);
                continue;
            }

            for skill in group_skills {
                // 在远程仓库中找到匹配的 Skill 目录
                let remote_match = remote_skills.iter().find(|rs| {
                    // 匹配方式：安装名称的最后一段
                    let remote_install_name =
                        rs.directory.rsplit('/').next().unwrap_or(&rs.directory);
                    remote_install_name.eq_ignore_ascii_case(&skill.directory)
                });

                let remote_skill_dir = match remote_match {
                    Some(rs) => {
                        match Self::resolve_skill_source_dir_checked(&temp_dir, &rs.directory) {
                            Ok(Some(path)) => path,
                            Ok(None) => continue,
                            Err(error) => {
                                log::warn!(
                                    "解析远程 Skill 源目录失败 {} ({}): {error:#}",
                                    skill.id,
                                    rs.directory
                                );
                                continue;
                            }
                        }
                    }
                    None => continue,
                };

                let remote_hash = match Self::compute_dir_hash(&remote_skill_dir) {
                    Ok(h) => h,
                    Err(e) => {
                        log::warn!("计算远程哈希失败 {}: {e}", skill.id);
                        continue;
                    }
                };

                // 本地哈希：优先数据库，否则实时计算
                let local_hash = match &skill.content_hash {
                    Some(h) => Some(h.clone()),
                    None => {
                        let local_dir = ssot_dir.join(&skill.directory);
                        if Self::normal_directory_exists(&local_dir)? {
                            match Self::compute_dir_hash(&local_dir) {
                                Ok(h) => {
                                    let _ = db.update_skill_hash(&skill.id, &h, 0);
                                    Some(h)
                                }
                                Err(_) => None,
                            }
                        } else {
                            None
                        }
                    }
                };

                if local_hash.as_deref() != Some(&remote_hash) {
                    updates.push(SkillUpdateInfo {
                        id: skill.id.clone(),
                        name: skill.name.clone(),
                        current_hash: local_hash,
                        remote_hash,
                    });
                }
            }

            let _ = Self::remove_path(&temp_dir);
        }

        Ok(updates)
    }

    /// 更新单个 Skill（重新下载并替换本地文件）
    pub async fn update_skill(&self, db: &Arc<Database>, skill_id: &str) -> Result<InstalledSkill> {
        let skill = db
            .get_installed_skill(skill_id)?
            .ok_or_else(|| anyhow!("Skill not found: {skill_id}"))?;
        Self::validate_managed_skill_directory(&skill.directory)?;

        let (owner, name, branch) = match (&skill.repo_owner, &skill.repo_name) {
            (Some(o), Some(n)) => (
                o.clone(),
                n.clone(),
                skill
                    .repo_branch
                    .clone()
                    .unwrap_or_else(|| "main".to_string()),
            ),
            _ => return Err(anyhow!("Cannot update local skill: {skill_id}")),
        };

        let repo = SkillRepo {
            owner: owner.clone(),
            name: name.clone(),
            branch: branch.clone(),
            enabled: true,
        };

        let ssot_dir = Self::get_ssot_dir()?;

        // 下载仓库
        let (temp_dir, used_branch) = timeout(
            std::time::Duration::from_secs(60),
            self.download_repo(&repo),
        )
        .await
        .map_err(|_| {
            anyhow!(format_skill_error(
                "DOWNLOAD_TIMEOUT",
                &[("owner", &owner), ("name", &name), ("timeout", "60")],
                Some("checkNetwork"),
            ))
        })??;

        // 在解压的仓库中查找 Skill 源目录
        let mut remote_skills: Vec<DiscoverableSkill> = Vec::new();
        if let Err(error) = self.scan_dir_recursive(&temp_dir, &temp_dir, &repo, &mut remote_skills)
        {
            let _ = Self::remove_path(&temp_dir);
            return Err(error).context("扫描远程 Skill 仓库失败");
        }

        let remote_match = remote_skills
            .iter()
            .find(|rs| {
                let remote_install_name = rs.directory.rsplit('/').next().unwrap_or(&rs.directory);
                remote_install_name.eq_ignore_ascii_case(&skill.directory)
            })
            .ok_or_else(|| {
                let _ = Self::remove_path(&temp_dir);
                anyhow!(format_skill_error(
                    "SKILL_DIR_NOT_FOUND",
                    &[("path", &skill.directory)],
                    Some("checkRepoUrl"),
                ))
            })?;

        let source =
            match Self::resolve_skill_source_dir_checked(&temp_dir, &remote_match.directory) {
                Ok(Some(source)) => source,
                Ok(None) => {
                    let missing = temp_dir.join(&remote_match.directory).display().to_string();
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "{} (temp_cleanup={cleanup_error:?})",
                        format_skill_error(
                            "SKILL_DIR_NOT_FOUND",
                            &[("path", &missing)],
                            Some("checkRepoUrl"),
                        )
                    ));
                }
                Err(error) => {
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "解析远程 Skill 源目录失败（temp_cleanup={cleanup_error:?}）: {error:#}"
                    ));
                }
            };

        // 保留用户可恢复的卸载备份，但真正更新使用同目录 staging + swap，
        // 不先删除旧版本，避免复制失败导致旧 Skill 丢失。
        if let Err(error) = Self::create_uninstall_backup(&skill) {
            log::warn!("更新 Skill 前创建备份失败，将继续使用可回滚 swap: {error:#}");
        }

        let dest = ssot_dir.join(&skill.directory);
        let (staged, staging_root) =
            match Self::stage_directory_copy(&source, &ssot_dir, &skill.directory) {
                Ok(value) => value,
                Err(error) => {
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "准备更新 Skill 失败（temp_cleanup={:?}）: {}",
                        cleanup_error,
                        error
                    ));
                }
            };
        let previous_dir = match Self::swap_staged_directory(&staged, &dest) {
            Ok(previous) => previous,
            Err(error) => {
                let staging_cleanup_error = Self::remove_path(&staging_root).err();
                let temp_cleanup_error = Self::remove_path(&temp_dir).err();
                return Err(anyhow!(
                    "替换 Skill 目录失败（staging_cleanup={:?}, temp_cleanup={:?}）: {}",
                    staging_cleanup_error,
                    temp_cleanup_error,
                    error
                ));
            }
        };
        let staging_cleanup_error = Self::remove_path(&staging_root).err();
        let temp_cleanup_error = Self::remove_path(&temp_dir).err();
        if staging_cleanup_error.is_some() || temp_cleanup_error.is_some() {
            let restore_error =
                Self::restore_swapped_directory(&dest, previous_dir.as_deref()).err();
            return Err(anyhow!(
                "更新 Skill 后临时目录清理失败，已尝试回滚（staging_cleanup={:?}, temp_cleanup={:?}, restore={:?}）",
                staging_cleanup_error,
                temp_cleanup_error,
                restore_error
            ));
        }

        // 计算新哈希；失败必须回滚，不能用 None 静默掩盖更新后的目录异常。
        let new_hash = match Self::compute_dir_hash(&dest) {
            Ok(hash) => Some(hash),
            Err(error) => {
                let restore_error =
                    Self::restore_swapped_directory(&dest, previous_dir.as_deref()).err();
                return Err(anyhow!(
                    "计算更新后的 Skill 哈希失败，已尝试恢复旧版本（restore={:?}）: {}",
                    restore_error,
                    error
                ));
            }
        };
        // 远端扫描阶段已经成功解析 SKILL.md，直接使用同一份元数据，避免
        // swap 后再次读取失败却继续写入不完整的数据库记录。
        let new_name = remote_match.name.clone();
        let new_description =
            Some(remote_match.description.clone()).filter(|value| !value.is_empty());

        // 更新 readme_url
        let doc_path = skill
            .readme_url
            .as_deref()
            .and_then(Self::extract_doc_path_from_url)
            .unwrap_or_else(|| format!("{}/SKILL.md", skill.directory.trim_end_matches('/')));
        let readme_url = Some(Self::build_skill_doc_url(
            &owner,
            &name,
            &used_branch,
            &doc_path,
        ));

        let updated_skill = InstalledSkill {
            id: skill.id.clone(),
            name: new_name,
            description: new_description,
            directory: skill.directory.clone(),
            repo_owner: skill.repo_owner.clone(),
            repo_name: skill.repo_name.clone(),
            repo_branch: Some(used_branch),
            readme_url,
            apps: skill.apps.clone(),
            installed_at: skill.installed_at,
            content_hash: new_hash,
            updated_at: chrono::Utc::now().timestamp(),
        };

        if let Err(error) = db.save_skill(&updated_skill) {
            let restore_error =
                Self::restore_swapped_directory(&dest, previous_dir.as_deref()).err();
            return Err(anyhow!(
                "保存更新后的 Skill 记录失败，已尝试恢复旧版本（restore={:?}）: {}",
                restore_error,
                error
            ));
        }

        // 任一应用投影失败都回滚 DB 与 SSOT，并尽力重新投影旧版本。
        for app in updated_skill.apps.enabled_apps() {
            if let Err(error) = Self::sync_managed_to_app_dir(&updated_skill.directory, &app) {
                let db_restore_error = db.save_skill(&skill).err();
                let ssot_restore_error =
                    Self::restore_swapped_directory(&dest, previous_dir.as_deref()).err();
                let mut projection_errors = Vec::new();
                for old_app in skill.apps.enabled_apps() {
                    if let Err(restore_projection_error) =
                        Self::sync_managed_to_app_dir(&skill.directory, &old_app)
                    {
                        projection_errors.push(format!("{old_app:?}: {restore_projection_error}"));
                    }
                }
                return Err(anyhow!(
                    "同步更新后的 Skill 失败，已回滚（db={:?}, ssot={:?}, projections={:?}）: {}",
                    db_restore_error,
                    ssot_restore_error,
                    projection_errors,
                    error
                ));
            }
        }

        if let Some(previous) = previous_dir {
            if let Err(error) = Self::remove_path(&previous) {
                return Err(anyhow!(
                    "Skill {} 更新已完成，但旧版本目录清理失败，需人工/后续重试（path={}）: {}",
                    updated_skill.name,
                    previous.display(),
                    error
                ));
            }
        }

        log::info!("Skill {} 更新成功", updated_skill.name);
        Ok(updated_skill)
    }

    /// 为缺少 content_hash 的已安装 Skill 补算哈希
    pub fn backfill_content_hashes(db: &Arc<Database>) -> Result<usize> {
        let skills = db.get_all_installed_skills()?;
        let ssot_dir = Self::get_ssot_dir()?;
        let mut count = 0;

        for skill in skills.values() {
            if skill.content_hash.is_some() {
                continue;
            }
            if Self::validate_managed_skill_directory(&skill.directory).is_err() {
                log::warn!("跳过目录字段非法的 Skill 哈希补算: {}", skill.id);
                continue;
            }
            let skill_dir = ssot_dir.join(&skill.directory);
            if !Self::normal_directory_exists(&skill_dir)? {
                continue;
            }
            match Self::compute_dir_hash(&skill_dir) {
                Ok(hash) => {
                    let _ = db.update_skill_hash(&skill.id, &hash, 0);
                    count += 1;
                }
                Err(e) => {
                    log::warn!("补算哈希失败 {}: {e}", skill.id);
                }
            }
        }

        if count > 0 {
            log::info!("已为 {count} 个 Skill 补算内容哈希");
        }
        Ok(count)
    }

    /// 迁移 Skill 存储位置（在两个 SSOT 目录间移动文件）
    ///
    /// 安全策略：先移文件，后改设置。中途崩溃时设置仍指向旧目录。
    pub fn migrate_storage(
        db: &Arc<Database>,
        target: SkillStorageLocation,
    ) -> Result<MigrationResult> {
        let current = crate::settings::get_skill_storage_location();
        if current == target {
            return Ok(MigrationResult {
                migrated_count: 0,
                skipped_count: 0,
                errors: vec![],
            });
        }

        // 1. 解析旧目录和新目录（不改设置）
        let old_dir = Self::get_ssot_dir()?;
        let new_dir = match target {
            SkillStorageLocation::CcSwitch => get_app_config_dir().join("skills"),
            SkillStorageLocation::Unified => {
                crate::config::get_home_dir().join(".agents").join("skills")
            }
        };
        Self::ensure_normal_directory(&new_dir)?;

        // 2. 逐个移动 skill 目录
        let skills = db.get_all_installed_skills()?;
        let mut result = MigrationResult {
            migrated_count: 0,
            skipped_count: 0,
            errors: vec![],
        };

        for skill in skills.values() {
            if Self::validate_managed_skill_directory(&skill.directory).is_err() {
                result
                    .errors
                    .push(format!("{}: 非法 Skill 目录名", skill.directory));
                continue;
            }
            let src = old_dir.join(&skill.directory);
            let dst = new_dir.join(&skill.directory);

            if !Self::normal_directory_exists(&src)? {
                result.skipped_count += 1;
                continue;
            }
            if Self::path_exists_no_follow(&dst)? {
                result.skipped_count += 1;
                continue;
            }

            // 优先 rename（同文件系统原子操作），失败则 copy+delete
            match fs::rename(&src, &dst) {
                Ok(()) => result.migrated_count += 1,
                Err(_) => match Self::copy_dir_recursive(&src, &dst) {
                    Ok(()) => {
                        let _ = Self::remove_path(&src);
                        result.migrated_count += 1;
                    }
                    Err(e) => {
                        result.errors.push(format!("{}: {e}", skill.directory));
                    }
                },
            }
        }

        // 3. 文件移动完成后才持久化设置
        crate::settings::set_skill_storage_location(target)?;

        // 4. 刷新所有应用目录的 symlink（指向新 SSOT）。同步错误必须返回给调用方，
        // 否则设置已指向新目录而旧投影仍可能继续被使用。
        for app in AppType::all() {
            if let Err(error) = Self::sync_to_app(db, &app) {
                result
                    .errors
                    .push(format!("同步 {:?} 应用目录失败: {error}", app));
            }
        }

        log::info!(
            "Skill 存储迁移完成: {} 迁移, {} 跳过, {} 错误",
            result.migrated_count,
            result.skipped_count,
            result.errors.len()
        );

        Ok(result)
    }

    pub fn list_backups() -> Result<Vec<SkillBackupEntry>> {
        let backup_dir = Self::get_backup_dir()?;
        let mut entries = Vec::new();

        for entry in fs::read_dir(&backup_dir)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    log::warn!("读取 Skill 备份目录项失败: {err}");
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(err) => {
                    log::warn!("读取 Skill 备份目录项元数据失败 {}: {err}", path.display());
                    continue;
                }
            };
            if metadata.file_type().is_symlink()
                || Self::has_reparse_point(&metadata)
                || !metadata.is_dir()
            {
                log::warn!("跳过非普通 Skill 备份目录: {}", path.display());
                continue;
            }

            match Self::read_backup_metadata(&path) {
                Ok(metadata) => entries.push(SkillBackupEntry {
                    backup_id: entry.file_name().to_string_lossy().to_string(),
                    backup_path: path.to_string_lossy().to_string(),
                    created_at: metadata.backup_created_at,
                    skill: metadata.skill,
                }),
                Err(err) => {
                    log::warn!("解析 Skill 备份失败 {}: {err:#}", path.display());
                }
            }
        }

        entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
        Ok(entries)
    }

    pub fn delete_backup(backup_id: &str) -> Result<()> {
        let backup_path = Self::backup_path_for_id(backup_id)?;
        let metadata = fs::symlink_metadata(&backup_path)
            .with_context(|| format!("failed to access {}", backup_path.display()))?;

        if metadata.file_type().is_symlink()
            || Self::has_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(anyhow!(
                "Skill backup is not a directory: {}",
                backup_path.display()
            ));
        }

        Self::validate_normal_directory_tree(&backup_path)?;
        Self::remove_path(&backup_path)
            .with_context(|| format!("failed to delete {}", backup_path.display()))?;

        log::info!("Skill 备份已删除: {}", backup_path.display());
        Ok(())
    }

    pub fn restore_from_backup(
        db: &Arc<Database>,
        backup_id: &str,
        current_app: &AppType,
    ) -> Result<InstalledSkill> {
        let backup_path = Self::backup_path_for_id(backup_id)?;
        if !Self::normal_directory_exists(&backup_path)? {
            return Err(anyhow!(
                "Skill backup is not a normal directory: {}",
                backup_path.display()
            ));
        }
        let metadata = Self::read_backup_metadata(&backup_path)?;
        let backup_skill_dir = backup_path.join("skill");
        if !Self::normal_file_exists(&backup_skill_dir.join("SKILL.md"))? {
            return Err(anyhow!(
                "Skill backup is invalid or missing SKILL.md: {}",
                backup_path.display()
            ));
        }

        Self::validate_managed_skill_directory(&metadata.skill.directory)?;
        let existing_skills = db.get_all_installed_skills()?;
        if existing_skills.contains_key(&metadata.skill.id)
            || existing_skills.values().any(|skill| {
                skill
                    .directory
                    .eq_ignore_ascii_case(&metadata.skill.directory)
            })
        {
            return Err(anyhow!(
                "Skill already exists, please uninstall the current one first: {}",
                metadata.skill.directory
            ));
        }

        let ssot_dir = Self::get_ssot_dir()?;
        let restore_path = ssot_dir.join(&metadata.skill.directory);
        if Self::path_exists_no_follow(&restore_path)? {
            return Err(anyhow!(
                "Restore target already exists: {}",
                restore_path.display()
            ));
        }

        let mut restored_skill = metadata.skill;
        restored_skill.installed_at = Utc::now().timestamp();
        restored_skill.apps = SkillApps::only(current_app);
        restored_skill.updated_at = 0;

        Self::copy_dir_recursive(&backup_skill_dir, &restore_path)?;

        // 重新计算内容哈希
        restored_skill.content_hash = match Self::compute_dir_hash(&restore_path) {
            Ok(hash) => Some(hash),
            Err(error) => {
                let cleanup_error = Self::remove_path(&restore_path).err();
                return Err(anyhow!(
                    "恢复 Skill 后计算内容哈希失败，已清理恢复目录（cleanup={cleanup_error:?}）: {error}"
                ));
            }
        };

        if let Err(err) = db.save_skill(&restored_skill) {
            let _ = Self::remove_path(&restore_path);
            return Err(err.into());
        }

        if !restored_skill.apps.is_empty() {
            if let Err(err) = Self::sync_to_app_dir(&restored_skill.directory, current_app) {
                let _ = db.delete_skill(&restored_skill.id);
                let _ = Self::remove_path(&restore_path);
                return Err(err);
            }
        }

        log::info!(
            "Skill {} 已从备份恢复到 {}",
            restored_skill.name,
            restore_path.display()
        );

        Ok(restored_skill)
    }

    /// 切换应用启用状态
    ///
    /// 启用：复制到应用目录
    /// 禁用：从应用目录删除
    pub fn toggle_app(db: &Arc<Database>, id: &str, app: &AppType, enabled: bool) -> Result<()> {
        // 获取当前 skill
        let mut skill = db
            .get_installed_skill(id)?
            .ok_or_else(|| anyhow!("Skill not found: {id}"))?;

        // 更新状态
        skill.apps.set_enabled_for(app, enabled);

        // 同步文件
        if enabled {
            Self::sync_managed_to_app_dir(&skill.directory, app)?;
        } else {
            Self::remove_from_app(&skill.directory, app)?;
        }

        // 更新数据库
        db.update_skill_apps(id, &skill.apps)?;

        log::info!("Skill {} 的 {:?} 状态已更新为 {}", skill.name, app, enabled);

        Ok(())
    }

    /// 扫描未管理的 Skills
    ///
    /// 扫描各应用目录，找出未被 CC Switch 管理的 Skills
    pub fn scan_unmanaged(db: &Arc<Database>) -> Result<Vec<UnmanagedSkill>> {
        let managed_skills = db.get_all_installed_skills()?;
        let managed_dirs: HashSet<String> = managed_skills
            .values()
            .map(|s| s.directory.clone())
            .collect();

        // 收集所有待扫描的目录及其来源标签；目录解析/安全检查失败必须终止，
        // 不能把不可读目录伪装成“没有未管理 Skill”。
        let mut scan_sources: Vec<(PathBuf, String)> = Vec::new();
        for app in AppType::all() {
            let dir = Self::get_app_skills_dir(&app)
                .with_context(|| format!("解析 {:?} Skill 目录失败", app))?;
            scan_sources.push((dir, app.as_str().to_string()));
        }
        if let Some(agents_dir) = get_agents_skills_dir()? {
            scan_sources.push((agents_dir, "agents".to_string()));
        }
        scan_sources.push((Self::get_ssot_dir()?, "cc-switch".to_string()));

        let mut unmanaged: HashMap<String, UnmanagedSkill> = HashMap::new();

        for (scan_dir, label) in &scan_sources {
            if !Self::normal_directory_exists(scan_dir)? {
                continue;
            }
            let entries = fs::read_dir(scan_dir)
                .with_context(|| format!("读取 Skill 扫描目录失败: {}", scan_dir.display()))?;
            for entry in entries {
                let entry = entry
                    .with_context(|| format!("遍历 Skill 扫描目录失败: {}", scan_dir.display()))?;
                let path = entry.path();
                if !Self::normal_directory_exists(&path)? {
                    continue;
                }
                let dir_name = entry.file_name().to_string_lossy().to_string();
                if dir_name.starts_with('.') || managed_dirs.contains(&dir_name) {
                    continue;
                }

                let skill_md = path.join("SKILL.md");
                if !Self::normal_file_exists(&skill_md)? {
                    continue;
                }
                let (name, description) = Self::read_skill_name_desc(&skill_md, &dir_name);

                unmanaged
                    .entry(dir_name.clone())
                    .and_modify(|s| s.found_in.push(label.clone()))
                    .or_insert(UnmanagedSkill {
                        directory: dir_name,
                        name,
                        description,
                        found_in: vec![label.clone()],
                        path: path.display().to_string(),
                    });
            }
        }

        Ok(unmanaged.into_values().collect())
    }

    /// 从应用目录导入 Skills
    ///
    /// 将未管理的 Skills 导入到 CC Switch 统一管理
    pub fn import_from_apps(
        db: &Arc<Database>,
        imports: Vec<ImportSkillSelection>,
    ) -> Result<Vec<InstalledSkill>> {
        let ssot_dir = Self::get_ssot_dir()?;
        let agents_lock = parse_agents_lock();
        let mut created_ssot_paths = Vec::new();

        let result: Result<Vec<InstalledSkill>> = (|| {
            let existing_skills = db.get_all_installed_skills()?;
            let existing_directories: HashSet<String> = existing_skills
                .values()
                .map(|skill| skill.directory.clone())
                .collect();
            let existing_ids: HashSet<String> = existing_skills.keys().cloned().collect();
            let mut staged_directories = HashSet::new();
            let mut imported = Vec::new();

            // 收集所有候选搜索目录
            let mut search_sources: Vec<(PathBuf, String)> = Vec::new();
            for app in AppType::all() {
                let dir = Self::get_app_skills_dir(&app)
                    .with_context(|| format!("解析 {:?} Skill 目录失败", app))?;
                search_sources.push((dir, app.as_str().to_string()));
            }
            if let Some(agents_dir) = get_agents_skills_dir()? {
                search_sources.push((agents_dir, "agents".to_string()));
            }
            search_sources.push((ssot_dir.clone(), "cc-switch".to_string()));

            for selection in imports {
                let dir_name = selection.directory;
                if Self::validate_managed_skill_directory(&dir_name).is_err() {
                    log::warn!("跳过目录字段非法的 Skill 导入: {}", dir_name);
                    continue;
                }
                if !staged_directories.insert(dir_name.clone()) {
                    return Err(anyhow!("同一批次重复导入 Skill: {dir_name}"));
                }
                if existing_directories.contains(&dir_name) {
                    return Err(anyhow!("拒绝覆盖已有数据库记录的 Skill: {dir_name}"));
                }

                // 在所有候选目录中查找；路径检查失败必须终止，不能静默漏导入。
                let mut source_path: Option<PathBuf> = None;
                for (base, label) in &search_sources {
                    let skill_path = base.join(&dir_name);
                    if Self::normal_directory_exists(&skill_path)? {
                        if source_path.is_none() {
                            source_path = Some(skill_path);
                        }
                        log::debug!("Skill '{dir_name}' found in source '{label}'");
                    }
                }

                let source = match source_path {
                    Some(p) => p,
                    None => continue,
                };
                if !Self::normal_file_exists(&source.join("SKILL.md"))? {
                    log::warn!(
                        "Skip importing '{}' because source '{}' has no SKILL.md",
                        dir_name,
                        source.display()
                    );
                    continue;
                }

                // 复制到 SSOT；本批次新建的目录统一由外层回滚。
                let dest = ssot_dir.join(&dir_name);
                let dest_exists = Self::path_exists_no_follow(&dest)?;
                if dest_exists && !Self::normal_directory_exists(&dest)? {
                    return Err(anyhow!(
                        "拒绝覆盖非普通目录的 Skill SSOT 路径: {}",
                        dest.display()
                    ));
                }
                if !dest_exists {
                    created_ssot_paths.push(dest.clone());
                    Self::copy_dir_recursive(&source, &dest)
                        .with_context(|| format!("复制 Skill 到 SSOT 失败: {}", dest.display()))?;
                }

                // 导入是持久化边界：损坏的 SKILL.md 元数据不能静默变成正常记录。
                let skill_md = dest.join("SKILL.md");
                let (name, description) = Self::read_skill_name_desc_strict(&skill_md, &dir_name)?;

                // 启用状态仅信任用户本次显式选择，不再根据“在哪些位置找到”自动推断。
                let apps = selection.apps;

                // 从 lock 文件提取仓库信息
                let (id, repo_owner, repo_name, repo_branch, readme_url) =
                    build_repo_info_from_lock(&agents_lock, &dir_name);
                if existing_ids.contains(&id)
                    || imported.iter().any(|skill: &InstalledSkill| skill.id == id)
                {
                    return Err(anyhow!("拒绝覆盖已有 ID 的 Skill: {id}"));
                }

                // 计算内容哈希
                let content_hash = Self::compute_dir_hash(&dest).with_context(|| {
                    format!("导入 Skill 后计算内容哈希失败: {}", dest.display())
                })?;

                imported.push(InstalledSkill {
                    id,
                    name,
                    description,
                    directory: dir_name,
                    repo_owner,
                    repo_name,
                    repo_branch,
                    readme_url,
                    apps,
                    installed_at: chrono::Utc::now().timestamp(),
                    content_hash: Some(content_hash),
                    updated_at: 0,
                });
            }

            let repos = repos_from_lock(
                &agents_lock,
                imported.iter().map(|skill| skill.directory.as_str()),
            );
            db.apply_skills_and_repos_atomic(&imported, &repos, false, None)
                .context("批量导入 Skills 写入数据库失败")?;

            Ok(imported)
        })();

        match result {
            Ok(imported) => {
                log::info!("成功导入 {} 个 Skills", imported.len());
                Ok(imported)
            }
            Err(error) => {
                let cleanup_errors = Self::cleanup_paths(&created_ssot_paths);
                if cleanup_errors.is_empty() {
                    Err(error)
                } else {
                    Err(anyhow!(
                        "批量导入失败: {error}；清理新 SSOT 时另有失败: {}",
                        cleanup_errors.join("; ")
                    ))
                }
            }
        }
    }

    // ========== 文件同步方法 ==========

    /// 创建符号链接（跨平台）
    ///
    /// - Unix: 使用 std::os::unix::fs::symlink
    /// - Windows: 使用 std::os::windows::fs::symlink_dir
    #[cfg(unix)]
    fn create_symlink(src: &Path, dest: &Path) -> Result<()> {
        std::os::unix::fs::symlink(src, dest)
            .with_context(|| format!("创建符号链接失败: {} -> {}", src.display(), dest.display()))
    }

    #[cfg(windows)]
    fn create_symlink(src: &Path, dest: &Path) -> Result<()> {
        std::os::windows::fs::symlink_dir(src, dest)
            .with_context(|| format!("创建符号链接失败: {} -> {}", src.display(), dest.display()))
    }

    /// 检查路径是否为符号链接
    fn is_symlink(path: &Path) -> bool {
        path.symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn has_reparse_point(metadata: &fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0400 != 0
    }

    #[cfg(not(windows))]
    fn has_reparse_point(_metadata: &fs::Metadata) -> bool {
        false
    }

    /// macOS 将 `/var` 作为指向 `/private/var` 的系统级固定别名。
    ///
    /// 临时目录通常位于 `/var/folders/...`；把该固定、可验证的系统别名
    /// 当作任意用户可控符号链接拒绝，会让安全的下载和解压路径失效。
    /// 仅放行精确的 `/var` -> `/private/var` 映射，其他任何符号链接仍会被拒绝。
    #[cfg(target_os = "macos")]
    fn is_macos_system_path_alias(path: &Path) -> bool {
        path == Path::new("/var")
            && matches!(
                fs::canonicalize(path),
                Ok(target) if target == Path::new("/private/var")
            )
    }

    #[cfg(not(target_os = "macos"))]
    fn is_macos_system_path_alias(_path: &Path) -> bool {
        false
    }

    fn validate_path_components(path: &Path) -> Result<()> {
        if path.as_os_str().is_empty() {
            return Err(anyhow!("目录路径不能为空"));
        }

        let mut current = Some(path);
        while let Some(candidate) = current {
            match fs::symlink_metadata(candidate) {
                Ok(metadata) => {
                    if (metadata.file_type().is_symlink()
                        && !Self::is_macos_system_path_alias(candidate))
                        || Self::has_reparse_point(&metadata)
                    {
                        return Err(anyhow!(
                            "路径不能穿过符号链接或 junction/reparse point: {}",
                            candidate.display()
                        ));
                    }
                    if candidate != path
                        && !metadata.is_dir()
                        && !Self::is_macos_system_path_alias(candidate)
                    {
                        return Err(anyhow!("路径包含非目录父组件: {}", candidate.display()));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("检查路径失败: {}", candidate.display()));
                }
            }
            current = candidate.parent();
        }
        Ok(())
    }

    fn normal_directory_exists(path: &Path) -> Result<bool> {
        Self::validate_path_components(path)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(metadata.is_dir()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("读取目录失败: {}", path.display())),
        }
    }

    fn normal_file_exists(path: &Path) -> Result<bool> {
        Self::validate_path_components(path)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("读取文件失败: {}", path.display())),
        }
    }

    fn path_exists_no_follow(path: &Path) -> Result<bool> {
        Self::validate_path_components(path)?;
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).with_context(|| format!("读取路径失败: {}", path.display())),
        }
    }

    /// Create a directory without traversing an attacker-controlled symlink or
    /// Windows junction/reparse point in any existing path component.
    fn ensure_normal_directory(path: &Path) -> Result<()> {
        Self::validate_path_components(path)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(anyhow!("目录路径不是普通目录: {}", path.display()));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("检查目录失败: {}", path.display()))
            }
        }

        fs::create_dir_all(path).with_context(|| format!("创建目录失败: {}", path.display()))?;
        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("读取新建目录失败: {}", path.display()))?;
        if metadata.file_type().is_symlink()
            || Self::has_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(anyhow!("新建路径不是普通目录: {}", path.display()));
        }
        Ok(())
    }

    fn is_managed_copy(path: &Path) -> bool {
        let Ok(path_metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if path_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&path_metadata)
            || !path_metadata.is_dir()
        {
            return false;
        }

        let marker = path.join(SKILL_PROJECTION_MARKER);
        let Ok(marker_metadata) = fs::symlink_metadata(&marker) else {
            return false;
        };
        if marker_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&marker_metadata)
            || !marker_metadata.is_file()
            || marker_metadata.len() != SKILL_PROJECTION_MARKER_CONTENT.len() as u64
        {
            return false;
        }

        fs::read(marker)
            .map(|content| content == SKILL_PROJECTION_MARKER_CONTENT)
            .unwrap_or(false)
    }

    fn write_projection_marker(path: &Path) -> Result<()> {
        let path_metadata = fs::symlink_metadata(path)
            .with_context(|| format!("读取 Skill 投影目录失败: {}", path.display()))?;
        if path_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&path_metadata)
            || !path_metadata.is_dir()
        {
            return Err(anyhow!("Skill 投影目标不是普通目录: {}", path.display()));
        }

        let marker = path.join(SKILL_PROJECTION_MARKER);
        if let Ok(marker_metadata) = fs::symlink_metadata(&marker) {
            if marker_metadata.file_type().is_symlink()
                || Self::has_reparse_point(&marker_metadata)
                || !marker_metadata.is_file()
            {
                return Err(anyhow!("Skill 投影标记不是普通文件: {}", marker.display()));
            }
        }
        fs::write(&marker, SKILL_PROJECTION_MARKER_CONTENT)
            .with_context(|| format!("写入 Skill 投影标记失败: {}", marker.display()))
    }

    fn validate_existing_projection_destination(dest: &Path, ssot_dir: &Path) -> Result<()> {
        let metadata = match fs::symlink_metadata(dest) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 应用目标失败: {}", dest.display()))
            }
        };

        if metadata.file_type().is_symlink() {
            if !Self::is_symlink_to_ssot(dest, ssot_dir) {
                return Err(anyhow!(
                    "拒绝操作指向 SSOT 之外的 Skill 符号链接: {}",
                    dest.display()
                ));
            }
            return Ok(());
        }

        if metadata.is_dir() && !Self::has_reparse_point(&metadata) && Self::is_managed_copy(dest) {
            Self::validate_normal_directory_tree(dest)?;
            return Ok(());
        }

        Err(anyhow!(
            "Skill 应用目标已存在且不属于 Chimera++ 管理投影，拒绝覆盖或删除: {}",
            dest.display()
        ))
    }

    /// 获取当前同步方式配置
    fn get_sync_method() -> SyncMethod {
        crate::settings::get_skill_sync_method()
    }

    /// 同步 Skill 到应用目录（使用 symlink 或 copy）
    ///
    /// 新安装、更新和恢复均不覆盖应用目录中已有的普通目录；只有已标记为
    /// Chimera++ 投影，或指向 SSOT 的受控符号链接才允许替换。
    pub fn sync_to_app_dir(directory: &str, app: &AppType) -> Result<()> {
        Self::sync_to_app_dir_internal(directory, app)
    }

    fn sync_managed_to_app_dir(directory: &str, app: &AppType) -> Result<()> {
        Self::sync_to_app_dir_internal(directory, app)
    }

    fn sync_to_app_dir_internal(directory: &str, app: &AppType) -> Result<()> {
        if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
            return Ok(());
        }

        let safe_directory = Self::sanitize_install_name(directory)
            .filter(|name| name == directory)
            .ok_or_else(|| anyhow!("Invalid Skill directory name: {directory}"))?;
        let ssot_dir = Self::get_ssot_dir()?;
        let source = ssot_dir.join(&safe_directory);

        Self::validate_sync_source_dir(&source, &safe_directory)?;

        let app_dir = Self::get_app_skills_dir(app)?;
        Self::ensure_normal_directory(&app_dir)?;

        let dest = app_dir.join(&safe_directory);
        Self::validate_existing_projection_destination(&dest, &ssot_dir)?;
        let existing = match fs::symlink_metadata(&dest) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 应用目标失败: {}", dest.display()))
            }
        };

        let sync_method = Self::get_sync_method();
        match sync_method {
            SyncMethod::Auto => {
                if existing
                    .as_ref()
                    .is_some_and(|metadata| metadata.file_type().is_symlink())
                {
                    Self::remove_path(&dest)?;
                }

                // 优先尝试 symlink；目标已存在的普通目录不会被静默覆盖。
                if !Self::path_exists_no_follow(&dest)? {
                    match Self::create_symlink(&source, &dest) {
                        Ok(()) => {
                            log::debug!("Skill {safe_directory} 已通过 symlink 同步到 {app:?}");
                            return Ok(());
                        }
                        Err(err) => {
                            log::warn!(
                                "Symlink 创建失败，将回退到文件复制: {} -> {}. 错误: {err:#}",
                                source.display(),
                                dest.display()
                            );
                        }
                    }
                }

                Self::replace_dest_with_copy(&source, &dest, &safe_directory)?;
                log::debug!("Skill {safe_directory} 已通过复制同步到 {app:?}");
            }
            SyncMethod::Symlink => {
                if Self::path_exists_no_follow(&dest)? {
                    Self::remove_path(&dest)?;
                }
                Self::create_symlink(&source, &dest)?;
                log::debug!("Skill {safe_directory} 已通过 symlink 同步到 {app:?}");
            }
            SyncMethod::Copy => {
                Self::replace_dest_with_copy(&source, &dest, &safe_directory)?;
                log::debug!("Skill {safe_directory} 已通过复制同步到 {app:?}");
            }
        }

        Ok(())
    }

    /// 复制 Skill 到应用目录（保留用于向后兼容）
    #[deprecated(note = "请使用 sync_to_app_dir() 代替")]
    pub fn copy_to_app(directory: &str, app: &AppType) -> Result<()> {
        Self::sync_to_app_dir(directory, app)
    }

    /// 验证目录树中的每个条目都是普通文件或普通目录。
    ///
    /// `remove_dir_all` 对顶层目录做 symlink_metadata 检查还不够：旧 Skill、
    /// 投影或备份内部可能残留嵌套 symlink/junction。先完整扫描，再递归删除，
    /// 避免清理动作穿过 Windows reparse point 或误删外部路径。
    fn validate_normal_directory_tree(path: &Path) -> Result<()> {
        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("读取目录树失败: {}", path.display()))?;
        if metadata.file_type().is_symlink()
            || Self::has_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(anyhow!("目录树包含非普通目录: {}", path.display()));
        }

        for entry in
            fs::read_dir(path).with_context(|| format!("读取目录树失败: {}", path.display()))?
        {
            let entry = entry?;
            let child = entry.path();
            let child_metadata = fs::symlink_metadata(&child)
                .with_context(|| format!("读取目录树条目失败: {}", child.display()))?;
            if child_metadata.file_type().is_symlink() || Self::has_reparse_point(&child_metadata) {
                return Err(anyhow!(
                    "目录树包含符号链接或 junction/reparse point: {}",
                    child.display()
                ));
            }
            if child_metadata.is_dir() {
                Self::validate_normal_directory_tree(&child)?;
            } else if !child_metadata.is_file() {
                return Err(anyhow!("目录树包含不支持的文件类型: {}", child.display()));
            }
        }
        Ok(())
    }

    /// 删除路径（支持 symlink 和真实目录），且不跟随 reparse point/junction。
    fn cleanup_paths(paths: &[PathBuf]) -> Vec<String> {
        let mut errors = Vec::new();
        for path in paths.iter().rev() {
            if let Err(error) = Self::remove_path(path) {
                errors.push(format!("{}: {error}", path.display()));
            }
        }
        errors
    }

    fn remove_path(path: &Path) -> Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };

        if metadata.file_type().is_symlink() {
            // 符号链接：仅删除链接本身，不影响源文件。
            #[cfg(unix)]
            fs::remove_file(path)?;
            #[cfg(windows)]
            {
                // Windows 无法仅凭 symlink_metadata 区分 broken file/dir link，
                // 先按目录链接删除，失败后再按文件链接删除；两者都只移除链接本身。
                if let Err(directory_error) = fs::remove_dir(path) {
                    fs::remove_file(path).with_context(|| {
                        format!(
                            "删除 Skill 符号链接失败（目录错误: {directory_error}）: {}",
                            path.display()
                        )
                    })?;
                }
            }
        } else if Self::has_reparse_point(&metadata) {
            return Err(anyhow!(
                "拒绝递归删除包含 reparse point/junction 的路径: {}",
                path.display()
            ));
        } else if metadata.is_dir() {
            // 真实目录：先检查整棵树，再递归删除。
            Self::validate_normal_directory_tree(path)?;
            fs::remove_dir_all(path)?;
        } else if metadata.is_file() {
            // 普通文件。
            fs::remove_file(path)?;
        } else {
            return Err(anyhow!("拒绝删除不支持的文件类型: {}", path.display()));
        }
        Ok(())
    }

    fn validate_sync_source_dir(source: &Path, directory: &str) -> Result<()> {
        if Self::sanitize_install_name(directory).as_deref() != Some(directory) {
            return Err(anyhow!("Invalid Skill directory name: {directory}"));
        }

        let source_metadata = fs::symlink_metadata(source)
            .with_context(|| format!("读取 Skill 源目录失败: {}", source.display()))?;
        if source_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&source_metadata)
            || !source_metadata.is_dir()
        {
            return Err(anyhow!(
                "Skill 不存在于 SSOT 或源路径不是普通目录: {directory}"
            ));
        }

        let manifest = source.join("SKILL.md");
        let manifest_metadata = fs::symlink_metadata(&manifest).with_context(|| {
            format!("Skill 源目录缺少 SKILL.md，拒绝同步: {}", source.display())
        })?;
        if manifest_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&manifest_metadata)
            || !manifest_metadata.is_file()
        {
            return Err(anyhow!(
                "Skill 源目录的 SKILL.md 不是普通文件，拒绝同步以避免覆盖目标目录: {}",
                manifest.display()
            ));
        }

        Ok(())
    }

    fn replace_dest_with_copy(source: &Path, dest: &Path, directory: &str) -> Result<()> {
        Self::validate_sync_source_dir(source, directory)?;

        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("Invalid skill destination: {}", dest.display()))?;
        Self::ensure_normal_directory(parent)?;

        let tmp = Self::unique_sibling_path(parent, directory, "copy")?;

        if let Err(error) = Self::copy_dir_recursive(source, &tmp) {
            let _ = Self::remove_path(&tmp);
            return Err(error);
        }

        let ssot_dir = source
            .parent()
            .ok_or_else(|| anyhow!("Invalid Skill source path: {}", source.display()))?;
        if let Err(error) = Self::validate_existing_projection_destination(dest, ssot_dir) {
            let _ = Self::remove_path(&tmp);
            return Err(error);
        }

        let backup = if fs::symlink_metadata(dest).is_ok() {
            let name = dest
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(directory);
            let backup = Self::unique_sibling_path(parent, name, "previous-copy")?;
            fs::rename(dest, &backup).with_context(|| {
                let _ = Self::remove_path(&tmp);
                format!("备份旧 Skill 投影失败: {}", dest.display())
            })?;
            Some(backup)
        } else {
            None
        };

        if let Err(error) = fs::rename(&tmp, dest) {
            let _ = Self::remove_path(&tmp);
            if let Some(previous) = &backup {
                if let Err(restore_error) = fs::rename(previous, dest) {
                    return Err(anyhow!(
                        "替换 Skill 投影失败: {error}; 恢复旧投影也失败: {restore_error}"
                    ));
                }
            }
            return Err(error).with_context(|| {
                format!(
                    "替换 Skill 目录失败: {} -> {}",
                    tmp.display(),
                    dest.display()
                )
            });
        }

        if let Err(marker_error) = Self::write_projection_marker(dest) {
            let restore_error = Self::restore_swapped_directory(dest, backup.as_deref()).err();
            return Err(anyhow!(
                "写入 Skill 投影所有权标记失败，已尝试恢复旧投影（restore={:?}）: {}",
                restore_error,
                marker_error
            ));
        }

        if let Some(previous) = backup {
            if let Err(error) = Self::remove_path(&previous) {
                log::warn!(
                    "清理旧 Skill 投影备份失败 {}: {error:#}",
                    previous.display()
                );
            }
        }

        Ok(())
    }

    /// 判断路径是否为指向 SSOT 目录内的符号链接。
    fn is_symlink_to_ssot(path: &Path, ssot_dir: &Path) -> bool {
        if !Self::is_symlink(path) {
            return false;
        }

        let Ok(target) = fs::read_link(path) else {
            return false;
        };

        if target.is_absolute() && target.starts_with(ssot_dir) {
            return true;
        }

        let resolved = path
            .parent()
            .map(|parent| parent.join(&target))
            .unwrap_or(target.clone());

        let canonical_ssot = ssot_dir
            .canonicalize()
            .unwrap_or_else(|_| ssot_dir.to_path_buf());
        let canonical_target = resolved.canonicalize().unwrap_or(resolved);

        canonical_target.starts_with(&canonical_ssot)
    }

    /// 从应用目录删除 Skill（仅允许删除 Chimera++ 自己创建的投影）。
    pub fn remove_from_app(directory: &str, app: &AppType) -> Result<()> {
        if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
            return Ok(());
        }

        let safe_directory = Self::sanitize_install_name(directory)
            .filter(|name| name == directory)
            .ok_or_else(|| anyhow!("Invalid Skill directory name: {directory}"))?;
        let ssot_dir = Self::get_ssot_dir()?;
        let app_dir = Self::get_app_skills_dir(app)?;
        Self::validate_path_components(&app_dir)?;
        let skill_path = app_dir.join(&safe_directory);
        match fs::symlink_metadata(&skill_path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 应用目标失败: {}", skill_path.display()))
            }
        }

        Self::validate_existing_projection_destination(&skill_path, &ssot_dir)?;
        Self::remove_path(&skill_path)?;
        log::debug!("Skill {safe_directory} 已从 {app:?} 删除");

        Ok(())
    }

    /// 同步所有已启用的 Skills 到指定应用
    pub fn sync_to_app(db: &Arc<Database>, app: &AppType) -> Result<()> {
        if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
            return Ok(());
        }

        let skills = db.get_all_installed_skills()?;
        let ssot_dir = Self::get_ssot_dir()?;
        let app_dir = Self::get_app_skills_dir(app)?;
        Self::validate_path_components(&app_dir)?;

        let indexed_skills: HashMap<String, &InstalledSkill> = skills
            .values()
            .map(|skill| (skill.directory.to_lowercase(), skill))
            .collect();

        if Self::normal_directory_exists(&app_dir)? {
            for entry in fs::read_dir(&app_dir)? {
                let entry = entry?;
                let path = entry.path();
                let dir_name = entry.file_name().to_string_lossy().to_string();

                if dir_name.starts_with('.') {
                    continue;
                }

                if let Some(skill) = indexed_skills.get(&dir_name.to_lowercase()) {
                    if !skill.apps.is_enabled_for(app) {
                        Self::remove_from_app(&skill.directory, app)?;
                    }
                    continue;
                }

                // 数据库中没有对应 Skill 时，只清理带有明确所有权标记的复制投影
                // 或指向 SSOT 的受控链接；用户手工放入的目录/外部链接必须保留。
                if Self::is_symlink_to_ssot(&path, &ssot_dir) || Self::is_managed_copy(&path) {
                    Self::remove_path(&path)?;
                }
            }
        }

        for skill in skills.values() {
            if skill.apps.is_enabled_for(app) {
                Self::sync_managed_to_app_dir(&skill.directory, app)?;
            }
        }

        Ok(())
    }

    // ========== 发现功能（保留原有逻辑）==========

    /// 列出所有可发现的技能（从仓库获取）
    pub async fn discover_available(
        &self,
        repos: Vec<SkillRepo>,
    ) -> Result<Vec<DiscoverableSkill>> {
        let mut skills = Vec::new();

        // 仅使用启用的仓库
        let enabled_repos: Vec<SkillRepo> = repos.into_iter().filter(|repo| repo.enabled).collect();

        let fetch_tasks = enabled_repos
            .iter()
            .map(|repo| self.fetch_repo_skills(repo));

        let results: Vec<Result<Vec<DiscoverableSkill>>> =
            futures::future::join_all(fetch_tasks).await;

        for (repo, result) in enabled_repos.into_iter().zip(results) {
            match result {
                Ok(repo_skills) => skills.extend(repo_skills),
                Err(e) => log::warn!("获取仓库 {}/{} 技能失败: {}", repo.owner, repo.name, e),
            }
        }

        // 去重并排序
        Self::deduplicate_discoverable_skills(&mut skills);
        skills.sort_by_key(|skill| skill.name.to_lowercase());

        Ok(skills)
    }

    /// 列出所有技能（兼容旧 API）
    pub async fn list_skills(
        &self,
        repos: Vec<SkillRepo>,
        db: &Arc<Database>,
    ) -> Result<Vec<Skill>> {
        // 获取可发现的技能
        let discoverable = self.discover_available(repos).await?;

        // 获取已安装的技能
        let installed = db.get_all_installed_skills()?;
        let installed_dirs: HashSet<String> =
            installed.values().map(|s| s.directory.clone()).collect();

        // 转换为 Skill 格式
        let mut skills: Vec<Skill> = discoverable
            .into_iter()
            .map(|d| {
                let install_name = Path::new(&d.directory)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| d.directory.clone());

                Skill {
                    key: d.key,
                    name: d.name,
                    description: d.description,
                    directory: d.directory,
                    readme_url: d.readme_url,
                    installed: installed_dirs.contains(&install_name),
                    repo_owner: Some(d.repo_owner),
                    repo_name: Some(d.repo_name),
                    repo_branch: Some(d.repo_branch),
                }
            })
            .collect();

        // 添加本地已安装但不在仓库中的技能
        for skill in installed.values() {
            let already_in_list = skills.iter().any(|s| {
                let s_install_name = Path::new(&s.directory)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| s.directory.clone());
                s_install_name == skill.directory
            });

            if !already_in_list {
                skills.push(Skill {
                    key: skill.id.clone(),
                    name: skill.name.clone(),
                    description: skill.description.clone().unwrap_or_default(),
                    directory: skill.directory.clone(),
                    readme_url: skill.readme_url.clone(),
                    installed: true,
                    repo_owner: skill.repo_owner.clone(),
                    repo_name: skill.repo_name.clone(),
                    repo_branch: skill.repo_branch.clone(),
                });
            }
        }

        skills.sort_by_key(|skill| skill.name.to_lowercase());

        Ok(skills)
    }

    /// 从仓库获取技能列表
    async fn fetch_repo_skills(&self, repo: &SkillRepo) -> Result<Vec<DiscoverableSkill>> {
        let (temp_dir, resolved_branch) =
            timeout(std::time::Duration::from_secs(60), self.download_repo(repo))
                .await
                .map_err(|_| {
                    anyhow!(format_skill_error(
                        "DOWNLOAD_TIMEOUT",
                        &[
                            ("owner", &repo.owner),
                            ("name", &repo.name),
                            ("timeout", "60")
                        ],
                        Some("checkNetwork"),
                    ))
                })??;

        let mut skills = Vec::new();
        let scan_dir = temp_dir.clone();
        let mut resolved_repo = repo.clone();
        resolved_repo.branch = resolved_branch;
        self.scan_dir_recursive(&scan_dir, &scan_dir, &resolved_repo, &mut skills)?;

        let _ = Self::remove_path(&temp_dir);

        Ok(skills)
    }

    /// 递归扫描目录查找 SKILL.md。
    ///
    /// 下载内容来自远端仓库，因此扫描本身也必须拒绝符号链接/junction，
    /// 并限制深度、目录数量和结果数量。
    fn scan_dir_recursive(
        &self,
        current_dir: &Path,
        base_dir: &Path,
        repo: &SkillRepo,
        skills: &mut Vec<DiscoverableSkill>,
    ) -> Result<()> {
        let mut directories = 0usize;
        self.scan_dir_recursive_with_budget(
            current_dir,
            base_dir,
            repo,
            skills,
            &mut directories,
            0,
        )
    }

    fn scan_dir_recursive_with_budget(
        &self,
        current_dir: &Path,
        base_dir: &Path,
        repo: &SkillRepo,
        skills: &mut Vec<DiscoverableSkill>,
        directories: &mut usize,
        depth: usize,
    ) -> Result<()> {
        let current_metadata = fs::symlink_metadata(current_dir)
            .with_context(|| format!("读取远端 Skill 目录失败: {}", current_dir.display()))?;
        if current_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&current_metadata)
            || !current_metadata.is_dir()
        {
            return Err(anyhow!(
                "远端 Skill 扫描路径不是普通目录: {}",
                current_dir.display()
            ));
        }
        if depth > MAX_SKILL_DIRECTORY_DEPTH {
            return Err(anyhow!(
                "远端 Skill 目录递归深度超过限制（最多 {} 层）: {}",
                MAX_SKILL_DIRECTORY_DEPTH,
                current_dir.display()
            ));
        }
        *directories = (*directories)
            .checked_add(1)
            .ok_or_else(|| anyhow!("远端 Skill 目录数量溢出"))?;
        if *directories > MAX_SKILL_DIRECTORIES {
            return Err(anyhow!(
                "远端 Skill 目录数量超过限制（最多 {} 个）",
                MAX_SKILL_DIRECTORIES
            ));
        }
        if current_dir.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
            return Err(anyhow!(
                "远端 Skill 扫描路径过长: {}",
                current_dir.display()
            ));
        }

        let skill_md = current_dir.join("SKILL.md");
        let skill_md_metadata = match fs::symlink_metadata(&skill_md) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("读取远端 Skill 的 SKILL.md 失败: {}", skill_md.display())
                })
            }
        };
        if let Some(metadata) = skill_md_metadata {
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "远端 Skill 的 SKILL.md 不能是符号链接: {}",
                    skill_md.display()
                ));
            }
            if !metadata.is_file() {
                return Err(anyhow!(
                    "远端 Skill 的 SKILL.md 不是普通文件: {}",
                    skill_md.display()
                ));
            }

            let directory = if current_dir == base_dir {
                repo.name.clone()
            } else {
                current_dir
                    .strip_prefix(base_dir)
                    .unwrap_or(current_dir)
                    .to_string_lossy()
                    .replace('\\', "/")
            };

            let doc_path = skill_md
                .strip_prefix(base_dir)
                .unwrap_or(skill_md.as_path())
                .to_string_lossy()
                .replace('\\', "/");

            let skill = self.build_skill_from_metadata(&skill_md, &directory, &doc_path, repo)?;
            if skills.len() >= MAX_DISCOVERED_SKILLS {
                return Err(anyhow!(
                    "远端仓库发现的 Skill 数量超过限制（最多 {} 个）",
                    MAX_DISCOVERED_SKILLS
                ));
            }
            skills.push(skill);

            return Ok(());
        }

        for entry in fs::read_dir(current_dir)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("读取远端 Skill 条目失败: {}", path.display()))?;
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "远端 Skill 扫描遇到符号链接或 junction: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                self.scan_dir_recursive_with_budget(
                    &path,
                    base_dir,
                    repo,
                    skills,
                    directories,
                    depth + 1,
                )?;
            }
        }

        Ok(())
    }

    /// 从 SKILL.md 构建技能对象
    fn build_skill_from_metadata(
        &self,
        skill_md: &Path,
        directory: &str,
        doc_path: &str,
        repo: &SkillRepo,
    ) -> Result<DiscoverableSkill> {
        let meta = self.parse_skill_metadata(skill_md)?;

        Ok(DiscoverableSkill {
            key: format!("{}/{}:{}", repo.owner, repo.name, directory),
            name: meta.name.unwrap_or_else(|| directory.to_string()),
            description: meta.description.unwrap_or_default(),
            directory: directory.to_string(),
            readme_url: Some(Self::build_skill_doc_url(
                &repo.owner,
                &repo.name,
                &repo.branch,
                doc_path,
            )),
            repo_owner: repo.owner.clone(),
            repo_name: repo.name.clone(),
            repo_branch: repo.branch.clone(),
        })
    }

    /// 解析技能元数据
    fn parse_skill_metadata(&self, path: &Path) -> Result<SkillMetadata> {
        Self::parse_skill_metadata_static(path)
    }

    /// 静态方法：解析技能元数据
    fn parse_skill_metadata_static(path: &Path) -> Result<SkillMetadata> {
        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("读取 SKILL.md 元数据失败: {}", path.display()))?;
        if metadata.file_type().is_symlink()
            || Self::has_reparse_point(&metadata)
            || !metadata.is_file()
        {
            return Err(anyhow!("SKILL.md 不是普通文件: {}", path.display()));
        }
        if metadata.len() > MAX_SKILL_SINGLE_FILE_BYTES {
            return Err(anyhow!(
                "SKILL.md 超过单文件大小限制（最多 {} MiB）: {}",
                MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                path.display()
            ));
        }
        let file = fs::File::open(path)
            .with_context(|| format!("打开 SKILL.md 失败: {}", path.display()))?;
        let mut bytes = Vec::new();
        file.take(MAX_SKILL_SINGLE_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("读取 SKILL.md 失败: {}", path.display()))?;
        if bytes.len() as u64 > MAX_SKILL_SINGLE_FILE_BYTES {
            return Err(anyhow!(
                "SKILL.md 超过单文件大小限制（最多 {} MiB）: {}",
                MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                path.display()
            ));
        }
        let content = String::from_utf8(bytes)
            .with_context(|| format!("SKILL.md 不是有效 UTF-8: {}", path.display()))?;
        let content = content.trim_start_matches('\u{feff}');

        let parts: Vec<&str> = content.splitn(3, "---").collect();
        if parts.len() < 3 {
            return Ok(SkillMetadata {
                name: None,
                description: None,
            });
        }

        let front_matter = parts[1].trim();
        if front_matter.is_empty() {
            return Ok(SkillMetadata {
                name: None,
                description: None,
            });
        }
        let meta: SkillMetadata = serde_yaml::from_str(front_matter)
            .with_context(|| format!("解析 SKILL.md YAML 元数据失败: {}", path.display()))?;

        Ok(meta)
    }

    fn read_skill_name_desc_strict(
        skill_md: &Path,
        fallback_name: &str,
    ) -> Result<(String, Option<String>)> {
        let meta = Self::parse_skill_metadata_static(skill_md)?;
        Ok((
            meta.name.unwrap_or_else(|| fallback_name.to_string()),
            meta.description,
        ))
    }

    /// 从 SKILL.md 读取名称和描述，不存在则用目录名兜底。
    /// 解析失败时保留兼容性回退，但必须留下明确日志，避免把损坏元数据伪装成正常数据。
    fn read_skill_name_desc(skill_md: &Path, fallback_name: &str) -> (String, Option<String>) {
        match Self::normal_file_exists(skill_md) {
            Ok(true) => match Self::parse_skill_metadata_static(skill_md) {
                Ok(meta) => (
                    meta.name.unwrap_or_else(|| fallback_name.to_string()),
                    meta.description,
                ),
                Err(error) => {
                    log::warn!(
                        "解析 Skill 元数据失败，使用目录名回退: {}: {error}",
                        skill_md.display()
                    );
                    (fallback_name.to_string(), None)
                }
            },
            Ok(false) => (fallback_name.to_string(), None),
            Err(error) => {
                log::warn!(
                    "检查 Skill 元数据文件失败，使用目录名回退: {}: {error}",
                    skill_md.display()
                );
                (fallback_name.to_string(), None)
            }
        }
    }

    /// 校验并规范化技能源路径（允许多级目录），拒绝路径穿越和绝对路径
    fn sanitize_skill_source_path(raw: &str) -> Option<PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut normalized = PathBuf::new();
        let mut has_component = false;

        for component in Path::new(trimmed).components() {
            match component {
                Component::Normal(name) => {
                    let segment = name.to_string_lossy().trim().to_string();
                    if segment.is_empty() || segment == "." || segment == ".." {
                        return None;
                    }
                    normalized.push(segment);
                    has_component = true;
                }
                Component::CurDir
                | Component::ParentDir
                | Component::RootDir
                | Component::Prefix(_) => {
                    return None;
                }
            }
        }

        has_component.then_some(normalized)
    }

    /// 校验并规范化安装目录名（最终落盘目录名，仅单段）
    fn sanitize_install_name(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let path = Path::new(trimmed);
        let mut components = path.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => {
                let normalized = name.to_string_lossy().trim().to_string();
                if normalized.is_empty()
                    || normalized == "."
                    || normalized == ".."
                    || normalized.starts_with('.')
                {
                    None
                } else {
                    Some(normalized)
                }
            }
            _ => None,
        }
    }

    fn validate_managed_skill_directory(directory: &str) -> Result<()> {
        if Self::sanitize_install_name(directory)
            .filter(|name| name == directory)
            .is_none()
        {
            return Err(anyhow!("Invalid managed Skill directory: {directory}"));
        }
        Ok(())
    }

    /// 在目录树中查找名称匹配且包含 SKILL.md 的子目录。
    ///
    /// 用于 skills.sh 安装回退：API 只返回 skillId（如 "find-skills"），
    /// 但实际文件可能在仓库子目录中（如 "skills/find-skills"）。
    /// 扫描错误必须向上传播，不能把权限错误或异常文件类型当成“没有找到”。
    fn find_skill_dir_by_name(root: &Path, target_name: &str) -> Result<Option<PathBuf>> {
        fn walk(dir: &Path, target: &str, depth: usize) -> Result<Option<PathBuf>> {
            if depth > 3 {
                return Ok(None);
            }
            let entries = fs::read_dir(dir)
                .with_context(|| format!("扫描 Skill 目录失败: {}", dir.display()))?;
            for entry in entries {
                let entry =
                    entry.with_context(|| format!("读取 Skill 目录条目失败: {}", dir.display()))?;
                let path = entry.path();
                if !SkillService::normal_directory_exists(&path)? {
                    continue;
                }
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with('.') {
                    continue;
                }
                if name_str.eq_ignore_ascii_case(target)
                    && SkillService::normal_file_exists(&path.join("SKILL.md"))?
                {
                    return Ok(Some(path));
                }
                if let Some(found) = walk(&path, target, depth + 1)? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        walk(root, target_name, 0)
    }

    /// 将 discoverable skill 的目录信息重新解析为解压目录中的真实源目录。
    ///
    /// 兼容三种情况：
    /// 1. `skills/foo` 这类直接相对路径；
    /// 2. 仅持有安装名 `foo`，需要在仓库中递归查找真实目录；
    /// 3. 仓库根目录本身就是 skill，此时回退到解压根目录。
    ///
    /// 这里返回 `Result`，因为路径扫描时的权限错误、I/O 错误和不安全路径
    /// 不能被折叠成 `None`，否则上层会误报“目录不存在”并继续使用不完整结果。
    fn resolve_skill_source_dir_checked(
        root: &Path,
        raw_directory: &str,
    ) -> Result<Option<PathBuf>> {
        if !Self::normal_directory_exists(root)? {
            return Ok(None);
        }
        let Some(source_rel) = Self::sanitize_skill_source_path(raw_directory) else {
            return Ok(None);
        };
        let direct = root.join(&source_rel);
        if Self::normal_directory_exists(&direct)? {
            return Ok(Some(direct));
        }

        let Some(target_name) = source_rel
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            return Ok(None);
        };
        if let Some(found) = Self::find_skill_dir_by_name(root, &target_name)? {
            log::info!(
                "Skill directory '{}' not found at direct path, using fallback: {}",
                target_name,
                found.display()
            );
            return Ok(Some(found));
        }

        if Self::normal_file_exists(&root.join("SKILL.md"))? {
            log::info!(
                "Skill directory '{}' not found, but SKILL.md exists at root, using repo root",
                target_name,
            );
            return Ok(Some(root.to_path_buf()));
        }

        Ok(None)
    }

    /// 去重技能列表（基于完整 key，不同仓库的同名 skill 分开显示）
    fn deduplicate_discoverable_skills(skills: &mut Vec<DiscoverableSkill>) {
        let mut seen = HashMap::new();
        skills.retain(|skill| {
            // 使用完整 key（owner/repo:directory）作为唯一标识
            // 这样不同仓库的同名 skill 会分开显示
            let unique_key = skill.key.to_lowercase();
            if let std::collections::hash_map::Entry::Vacant(e) = seen.entry(unique_key) {
                e.insert(true);
                true
            } else {
                false
            }
        });
    }

    /// 下载仓库
    async fn download_repo(&self, repo: &SkillRepo) -> Result<(PathBuf, String)> {
        let temp_dir = tempfile::tempdir()?;
        let temp_path = temp_dir.keep();

        let mut branches = Vec::new();
        if !repo.branch.is_empty() && !repo.branch.eq_ignore_ascii_case("HEAD") {
            branches.push(repo.branch.as_str());
        }
        if !branches.contains(&"main") {
            branches.push("main");
        }
        if !branches.contains(&"master") {
            branches.push("master");
        }

        let mut last_error = None;
        for branch in branches {
            let url = format!(
                "https://github.com/{}/{}/archive/refs/heads/{}.zip",
                repo.owner, repo.name, branch
            );

            match self.download_and_extract(&url, &temp_path).await {
                Ok(_) => {
                    return Ok((temp_path, branch.to_string()));
                }
                Err(e) => {
                    last_error = Some(e);
                    // 每个候选分支必须使用干净目录，避免失败分支的残留条目污染下一次解压。
                    let _ = Self::remove_path(&temp_path);
                    Self::ensure_normal_directory(&temp_path)?;
                    continue;
                }
            }
        }

        let _ = Self::remove_path(&temp_path);
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("所有分支下载失败")))
    }

    /// 下载并解压 ZIP
    async fn download_and_extract(&self, url: &str, dest: &Path) -> Result<()> {
        let client = crate::proxy::http_client::get();
        let response = client.get(url).send().await?;
        if !response.status().is_success() {
            let status = response.status().as_u16().to_string();
            return Err(anyhow::anyhow!(format_skill_error(
                "DOWNLOAD_FAILED",
                &[("status", &status)],
                match status.as_str() {
                    "403" => Some("http403"),
                    "404" => Some("http404"),
                    "429" => Some("http429"),
                    _ => Some("checkNetwork"),
                },
            )));
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_SKILL_ARCHIVE_BYTES)
        {
            return Err(anyhow!(
                "Skill 压缩包超过限制（最多 {} MiB）",
                MAX_SKILL_ARCHIVE_BYTES / (1024 * 1024)
            ));
        }

        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let next_len = bytes
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| anyhow!("Skill 压缩包大小溢出"))?;
            if next_len as u64 > MAX_SKILL_ARCHIVE_BYTES {
                return Err(anyhow!(
                    "Skill 压缩包超过限制（最多 {} MiB）",
                    MAX_SKILL_ARCHIVE_BYTES / (1024 * 1024)
                ));
            }
            bytes.extend_from_slice(&chunk);
        }

        Self::extract_zip_archive(Cursor::new(bytes), dest, true)
    }

    /// 使用统一资源预算解压 ZIP。GitHub 归档会去掉最外层仓库目录，
    /// 本地 ZIP 则保留原始相对路径。
    fn extract_zip_archive<R: Read + Seek>(reader: R, dest: &Path, strip_root: bool) -> Result<()> {
        let mut archive = zip::ZipArchive::new(reader)?;
        if archive.is_empty() {
            return Err(anyhow!(format_skill_error(
                "EMPTY_ARCHIVE",
                &[],
                Some("checkZipContent"),
            )));
        }
        if archive.len() > MAX_SKILL_ARCHIVE_ENTRIES {
            return Err(anyhow!(
                "Skill 压缩包条目数量超过限制（最多 {} 个）",
                MAX_SKILL_ARCHIVE_ENTRIES
            ));
        }

        let root_path = if strip_root {
            let first_path = {
                let first = archive.by_index(0)?;
                first
                    .enclosed_name()
                    .ok_or_else(|| anyhow!("Skill ZIP 包含不安全路径"))?
            };
            first_path
                .components()
                .next()
                .and_then(|component| match component {
                    Component::Normal(name) => Some(PathBuf::from(name)),
                    _ => None,
                })
                .ok_or_else(|| anyhow!("Skill ZIP 缺少有效根目录"))?
        } else {
            PathBuf::new()
        };

        Self::ensure_normal_directory(dest)?;
        // Windows paths are case-insensitive. Track archive paths using the
        // platform's collision semantics so `foo/SKILL.md` and
        // `Foo/SKILL.md` cannot overwrite the same extracted file.
        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut symlinks = Vec::new();
        let mut archive_total = 0u64;
        let mut output_budget = CopyBudget::default();

        for index in 0..archive.len() {
            let mut file = archive.by_index(index)?;
            let enclosed = file
                .enclosed_name()
                .ok_or_else(|| anyhow!("Skill ZIP 包含不安全路径"))?;

            let relative = if strip_root {
                if enclosed == root_path {
                    continue;
                }
                enclosed
                    .strip_prefix(&root_path)
                    .map(Path::to_path_buf)
                    .map_err(|_| anyhow!("Skill ZIP 条目不在统一根目录下"))?
            } else {
                enclosed
            };

            if relative.as_os_str().is_empty() {
                continue;
            }
            if relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            }) {
                return Err(anyhow!("Skill ZIP 包含路径穿越条目"));
            }
            if relative.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
                return Err(anyhow!("Skill ZIP 条目路径过长"));
            }

            let outpath = dest.join(&relative);
            let path_key = Self::archive_path_key(&relative);
            if !outpath.starts_with(dest) || !seen_paths.insert(path_key) {
                return Err(anyhow!("Skill ZIP 包含重复、大小写冲突或越界条目"));
            }

            let uncompressed_size = file.size();
            archive_total = archive_total
                .checked_add(uncompressed_size)
                .ok_or_else(|| anyhow!("Skill ZIP 解压大小溢出"))?;
            if archive_total > MAX_SKILL_TOTAL_BYTES {
                return Err(anyhow!(
                    "Skill ZIP 解压总大小超过限制（最多 {} MiB）",
                    MAX_SKILL_TOTAL_BYTES / (1024 * 1024)
                ));
            }
            if uncompressed_size > MAX_SKILL_SINGLE_FILE_BYTES {
                return Err(anyhow!(
                    "Skill ZIP 单文件超过限制（最多 {} MiB）: {}",
                    MAX_SKILL_SINGLE_FILE_BYTES / (1024 * 1024),
                    relative.display()
                ));
            }
            let compressed_size = file.compressed_size();
            if compressed_size == 0 {
                if uncompressed_size != 0 {
                    return Err(anyhow!("Skill ZIP 包含无效压缩大小"));
                }
            } else if uncompressed_size
                > compressed_size.saturating_mul(MAX_SKILL_COMPRESSION_RATIO)
            {
                return Err(anyhow!("Skill ZIP 压缩比超过安全限制"));
            }

            if file.is_symlink() {
                if symlinks.len() >= MAX_SKILL_SYMLINKS {
                    return Err(anyhow!(
                        "Skill ZIP 符号链接数量超过限制（最多 {} 个）",
                        MAX_SKILL_SYMLINKS
                    ));
                }
                let mut target_bytes = Vec::new();
                let mut limited = (&mut file).take((MAX_SKILL_PATH_BYTES + 1) as u64);
                limited.read_to_end(&mut target_bytes)?;
                if target_bytes.len() > MAX_SKILL_PATH_BYTES {
                    return Err(anyhow!("Skill ZIP 符号链接目标过长"));
                }
                let target = String::from_utf8(target_bytes)
                    .map_err(|_| anyhow!("Skill ZIP 符号链接目标不是有效 UTF-8"))?
                    .trim()
                    .to_string();
                if target.is_empty() || Path::new(&target).is_absolute() {
                    return Err(anyhow!("Skill ZIP 包含无效符号链接目标"));
                }
                symlinks.push((outpath, target));
            } else if file.is_dir() {
                Self::ensure_normal_directory(&outpath)?;
            } else {
                if let Some(parent) = outpath.parent() {
                    Self::ensure_normal_directory(parent)?;
                }
                match fs::symlink_metadata(&outpath) {
                    Ok(metadata)
                        if metadata.file_type().is_symlink()
                            || Self::has_reparse_point(&metadata)
                            || metadata.is_dir() =>
                    {
                        return Err(anyhow!(
                            "Skill ZIP 目标路径不是普通文件: {}",
                            outpath.display()
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                let mut outfile = fs::File::create(&outpath)?;
                let copied = std::io::copy(&mut file, &mut outfile)?;
                if copied != uncompressed_size {
                    return Err(anyhow!(
                        "Skill ZIP 文件大小校验失败: {}",
                        relative.display()
                    ));
                }
                output_budget.reserve(&outpath, copied)?;
            }
        }

        Self::resolve_symlinks_in_dir(dest, &symlinks, &mut output_budget)?;
        Ok(())
    }

    fn archive_path_key(path: &Path) -> String {
        #[cfg(windows)]
        {
            path.to_string_lossy().replace('\\', "/").to_lowercase()
        }
        #[cfg(not(windows))]
        {
            path.to_string_lossy().replace('\\', "/")
        }
    }

    /// 递归复制目录，并对文件数量、单文件大小、总大小和符号链接做统一限制。
    fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
        let mut budget = CopyBudget::default();
        Self::copy_dir_recursive_with_budget(src, dest, &mut budget, 0)
    }

    fn copy_dir_recursive_with_budget(
        src: &Path,
        dest: &Path,
        budget: &mut CopyBudget,
        depth: usize,
    ) -> Result<()> {
        let source_metadata = fs::symlink_metadata(src)?;
        if source_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&source_metadata)
            || !source_metadata.is_dir()
        {
            return Err(anyhow!("Skill 源路径不是普通目录: {}", src.display()));
        }
        if src.to_string_lossy().len() > MAX_SKILL_PATH_BYTES
            || dest.to_string_lossy().len() > MAX_SKILL_PATH_BYTES
        {
            return Err(anyhow!("Skill 路径过长"));
        }
        budget.reserve_directory(src, depth)?;
        Self::ensure_normal_directory(dest)?;

        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let path = entry.path();
            let dest_path = dest.join(entry.file_name());
            if dest_path.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
                return Err(anyhow!("Skill 路径过长: {}", dest_path.display()));
            }

            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "Skill 目录包含未解析符号链接或 junction: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                Self::copy_dir_recursive_with_budget(&path, &dest_path, budget, depth + 1)?;
            } else if metadata.is_file() {
                let size = metadata.len();
                budget.reserve(&path, size)?;
                fs::copy(&path, &dest_path)?;
            } else {
                return Err(anyhow!(
                    "Skill 目录包含不支持的文件类型: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    fn stage_directory_copy(
        source: &Path,
        parent: &Path,
        name: &str,
    ) -> Result<(PathBuf, PathBuf)> {
        Self::ensure_normal_directory(parent)?;
        let staging_dir = tempfile::Builder::new()
            .prefix(".chimera-skill-stage-")
            .tempdir_in(parent)?;
        let staging_root = staging_dir.keep();
        let staged = staging_root.join(Self::sanitize_backup_segment(name));
        if let Err(error) = Self::copy_dir_recursive(source, &staged) {
            let _ = Self::remove_path(&staging_root);
            return Err(error);
        }
        Ok((staged, staging_root))
    }

    fn unique_sibling_path(parent: &Path, name: &str, suffix: &str) -> Result<PathBuf> {
        let base_nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let safe_name = Self::sanitize_backup_segment(name);
        for attempt in 0u128..64 {
            let nonce = base_nonce.saturating_add(attempt);
            let candidate = parent.join(format!(
                ".{}-{}-{}-{}",
                safe_name,
                suffix,
                std::process::id(),
                nonce
            ));
            match fs::symlink_metadata(&candidate) {
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("检查临时 Skill 路径失败: {}", candidate.display())
                    })
                }
            }
        }
        Err(anyhow!(
            "无法生成未占用的临时 Skill 路径: {}",
            parent.display()
        ))
    }

    fn commit_new_directory(staged: &Path, dest: &Path) -> Result<()> {
        match fs::symlink_metadata(dest) {
            Ok(_) => return Err(anyhow!("Skill 目标目录已存在: {}", dest.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 目标目录失败: {}", dest.display()))
            }
        }
        fs::rename(staged, dest).with_context(|| {
            format!(
                "提交 Skill 目录失败: {} -> {}",
                staged.display(),
                dest.display()
            )
        })
    }

    fn swap_staged_directory(staged: &Path, dest: &Path) -> Result<Option<PathBuf>> {
        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("Invalid skill destination: {}", dest.display()))?;
        Self::ensure_normal_directory(parent)?;

        let staged_metadata = fs::symlink_metadata(staged)
            .with_context(|| format!("读取 staged Skill 目录失败: {}", staged.display()))?;
        if staged_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&staged_metadata)
            || !staged_metadata.is_dir()
        {
            return Err(anyhow!(
                "Invalid staged skill directory: {}",
                staged.display()
            ));
        }

        let existing = match fs::symlink_metadata(dest) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取 Skill 目标目录失败: {}", dest.display()))
            }
        };
        if existing.as_ref().is_some_and(|metadata| {
            metadata.file_type().is_symlink()
                || Self::has_reparse_point(metadata)
                || !metadata.is_dir()
        }) {
            return Err(anyhow!(
                "Skill destination is not a normal directory: {}",
                dest.display()
            ));
        }
        if existing.is_some() {
            let name = dest
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| anyhow!("Invalid skill destination: {}", dest.display()))?;
            // 更新只允许替换已经被识别为 Skill 的普通目录；不要把任意用户目录
            // 当作 DB 记录对应的 Skill 并递归移走。
            Self::validate_sync_source_dir(dest, name)?;
            Self::validate_normal_directory_tree(dest)?;
        }

        let backup = if existing.is_some() {
            let name = dest
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill");
            let backup = Self::unique_sibling_path(parent, name, "previous")?;
            fs::rename(dest, &backup)
                .with_context(|| format!("备份旧 Skill 目录失败: {}", dest.display()))?;
            Some(backup)
        } else {
            None
        };

        if let Err(error) = fs::rename(staged, dest) {
            if let Some(previous) = &backup {
                if let Err(restore_error) = fs::rename(previous, dest) {
                    return Err(anyhow!(
                        "替换 Skill 目录失败: {error}; 恢复旧目录也失败: {restore_error}"
                    ));
                }
            }
            return Err(error).with_context(|| {
                format!(
                    "替换 Skill 目录失败: {} -> {}",
                    staged.display(),
                    dest.display()
                )
            });
        }
        Ok(backup)
    }

    fn restore_swapped_directory(dest: &Path, backup: Option<&Path>) -> Result<()> {
        match fs::symlink_metadata(dest) {
            Ok(_) => Self::remove_path(dest)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("读取待恢复 Skill 目录失败: {}", dest.display()))
            }
        }
        if let Some(previous) = backup {
            fs::rename(previous, dest).with_context(|| {
                format!(
                    "恢复旧 Skill 目录失败: {} -> {}",
                    previous.display(),
                    dest.display()
                )
            })?;
        }
        Ok(())
    }

    fn restore_skill_from_backup_to_ssot(backup_path: &Path, dest: &Path) -> Result<()> {
        if !Self::normal_directory_exists(backup_path)? {
            return Err(anyhow!(
                "卸载备份不是普通目录，无法恢复 SSOT: {}",
                backup_path.display()
            ));
        }
        let source = backup_path.join("skill");
        if !Self::normal_directory_exists(&source)?
            || !Self::normal_file_exists(&source.join("SKILL.md"))?
        {
            return Err(anyhow!(
                "卸载备份缺少有效 Skill 内容，无法恢复 SSOT: {}",
                backup_path.display()
            ));
        }

        let parent = dest
            .parent()
            .ok_or_else(|| anyhow!("Invalid SSOT Skill destination: {}", dest.display()))?;
        Self::ensure_normal_directory(parent)?;
        if Self::path_exists_no_follow(dest)? {
            return Err(anyhow!(
                "恢复 SSOT 目标已经存在，拒绝覆盖: {}",
                dest.display()
            ));
        }

        let (staged, staging_root) =
            Self::stage_directory_copy(&source, parent, &Self::skill_name_from_path(dest)?)?;
        if let Err(error) = Self::commit_new_directory(&staged, dest) {
            let cleanup_error = Self::remove_path(&staging_root).err();
            return Err(anyhow!(
                "从卸载备份恢复 SSOT 失败（cleanup={:?}）: {}",
                cleanup_error,
                error
            ));
        }
        if let Err(cleanup_error) = Self::remove_path(&staging_root) {
            return Err(anyhow!(
                "SSOT 已从卸载备份恢复，但临时目录清理失败: {}",
                cleanup_error
            ));
        }
        Ok(())
    }

    fn skill_name_from_path(path: &Path) -> Result<String> {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
            .ok_or_else(|| anyhow!("Skill 路径缺少有效目录名: {}", path.display()))
    }

    fn restore_removed_app_projections(skill: &InstalledSkill, apps: &[AppType]) -> Vec<String> {
        let mut errors = Vec::new();
        for app in apps {
            if !skill.apps.is_enabled_for(app) {
                continue;
            }
            if let Err(error) = Self::sync_managed_to_app_dir(&skill.directory, app) {
                errors.push(format!("{app:?}: {error}"));
            }
        }
        errors
    }

    fn resolve_uninstall_backup_source(skill: &InstalledSkill) -> Result<Option<PathBuf>> {
        Self::validate_managed_skill_directory(&skill.directory)?;
        let ssot_path = Self::get_ssot_dir()?.join(&skill.directory);
        if Self::normal_directory_exists(&ssot_path)? {
            return Ok(Some(ssot_path));
        }

        for app in AppType::all() {
            let app_dir = match Self::get_app_skills_dir(&app) {
                Ok(dir) => dir,
                Err(_) => continue,
            };
            let candidate = app_dir.join(&skill.directory);
            if Self::normal_directory_exists(&candidate)? {
                return Ok(Some(candidate));
            }
        }

        Ok(None)
    }

    fn sanitize_backup_segment(segment: &str) -> String {
        let sanitized = segment
            .chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
                _ => '-',
            })
            .collect::<String>()
            .trim_matches('-')
            .to_string();

        if sanitized.is_empty() {
            "skill".to_string()
        } else {
            sanitized
        }
    }

    fn cleanup_old_skill_backups(dir: &Path) -> Result<()> {
        let mut entries = fs::read_dir(dir)?
            .map(|entry| {
                let entry = entry?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)
                    .with_context(|| format!("读取 Skill 备份元数据失败: {}", path.display()))?;
                if metadata.file_type().is_symlink()
                    || Self::has_reparse_point(&metadata)
                    || !metadata.is_dir()
                {
                    return Err(anyhow!(
                        "Skill 备份目录包含非普通目录，拒绝清理: {}",
                        path.display()
                    ));
                }
                Self::validate_normal_directory_tree(&path)?;
                let modified = metadata
                    .modified()
                    .with_context(|| format!("读取 Skill 备份修改时间失败: {}", path.display()))?;
                Ok((path, modified))
            })
            .collect::<Result<Vec<_>>>()?;

        if entries.len() <= SKILL_BACKUP_RETAIN_COUNT {
            return Ok(());
        }

        entries.sort_by_key(|(_, modified)| *modified);
        let remove_count = entries.len().saturating_sub(SKILL_BACKUP_RETAIN_COUNT);

        for (path, _) in entries.into_iter().take(remove_count) {
            Self::remove_path(&path)?;
        }

        Ok(())
    }

    fn backup_path_for_id(backup_id: &str) -> Result<PathBuf> {
        // Backup IDs are generated as ordinary single path segments. Keep the
        // same invariant when the ID comes back from the UI/API: accepting "."
        // would resolve to the backup root and make delete_backup(".") remove
        // every backup.
        let valid = !backup_id.is_empty()
            && backup_id == backup_id.trim()
            && backup_id != "."
            && backup_id != ".."
            && backup_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
            && !backup_id.ends_with('.');
        if !valid {
            return Err(anyhow!("Invalid backup id: {backup_id}"));
        }

        Ok(Self::get_backup_dir()?.join(backup_id))
    }

    fn read_backup_metadata(backup_path: &Path) -> Result<SkillBackupMetadata> {
        let metadata_path = backup_path.join("meta.json");
        let content = fs::read_to_string(&metadata_path)
            .with_context(|| format!("failed to read {}", metadata_path.display()))?;
        serde_json::from_str(&content)
            .with_context(|| format!("failed to parse {}", metadata_path.display()))
    }

    fn create_uninstall_backup(skill: &InstalledSkill) -> Result<Option<PathBuf>> {
        Self::validate_managed_skill_directory(&skill.directory)?;
        let Some(source_path) = Self::resolve_uninstall_backup_source(skill)? else {
            log::warn!(
                "Skill {} 卸载前未找到可备份的目录，将跳过备份",
                skill.directory
            );
            return Ok(None);
        };

        let backup_root = Self::get_backup_dir()?;
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        let slug = Self::sanitize_backup_segment(&skill.directory);
        let mut backup_path = backup_root.join(format!("{timestamp}_{slug}"));
        let mut counter = 1;
        loop {
            match fs::symlink_metadata(&backup_path) {
                Ok(_) => {
                    backup_path = backup_root.join(format!("{timestamp}_{slug}_{counter}"));
                    counter += 1;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("检查 Skill 备份目标失败: {}", backup_path.display())
                    });
                }
            }
        }

        let write_backup = || -> Result<()> {
            let skill_backup_dir = backup_path.join("skill");
            Self::copy_dir_recursive(&source_path, &skill_backup_dir)?;

            let metadata = SkillBackupMetadata {
                skill: skill.clone(),
                backup_created_at: Utc::now().timestamp(),
                source_path: source_path.to_string_lossy().to_string(),
            };
            let metadata_path = backup_path.join("meta.json");
            let metadata_json = serde_json::to_string_pretty(&metadata)
                .context("failed to serialize skill backup metadata")?;
            fs::write(&metadata_path, metadata_json)
                .with_context(|| format!("failed to write {}", metadata_path.display()))?;
            Ok(())
        };

        if let Err(err) = write_backup() {
            let _ = Self::remove_path(&backup_path);
            return Err(err);
        }

        if let Err(err) = Self::cleanup_old_skill_backups(&backup_root) {
            log::warn!("清理旧 Skill 备份失败: {err:#}");
        }

        log::info!(
            "Skill {} 已在卸载前备份到 {}",
            skill.name,
            backup_path.display()
        );

        Ok(Some(backup_path))
    }

    /// 解析 ZIP 中的符号链接：将目标内容复制到 symlink 位置。
    /// 不创建真实符号链接，且只允许目标留在归档根目录内。
    fn resolve_symlinks_in_dir(
        base_dir: &Path,
        symlinks: &[(PathBuf, String)],
        budget: &mut CopyBudget,
    ) -> Result<()> {
        let canonical_base = base_dir
            .canonicalize()
            .unwrap_or_else(|_| base_dir.to_path_buf());
        let mut pending = symlinks.to_vec();

        for _ in 0..=MAX_SKILL_SYMLINKS {
            if pending.is_empty() {
                return Ok(());
            }
            let mut next = Vec::new();
            let mut progressed = false;

            for (link_path, target) in pending {
                let parent = link_path.parent().unwrap_or(base_dir);
                let resolved = match parent.join(&target).canonicalize() {
                    Ok(path) => path,
                    Err(_) => {
                        next.push((link_path, target));
                        continue;
                    }
                };

                if !resolved.starts_with(&canonical_base) {
                    return Err(anyhow!(
                        "Skill ZIP 符号链接目标超出仓库范围: {} -> {}",
                        link_path.display(),
                        target
                    ));
                }
                if !link_path.starts_with(base_dir) {
                    return Err(anyhow!(
                        "Skill ZIP 符号链接路径越界: {}",
                        link_path.display()
                    ));
                }

                if resolved.is_dir() {
                    Self::copy_dir_recursive_with_budget(&resolved, &link_path, budget, 0)?;
                } else if resolved.is_file() {
                    let metadata = fs::metadata(&resolved)?;
                    budget.reserve(&resolved, metadata.len())?;
                    if let Some(parent) = link_path.parent() {
                        Self::ensure_normal_directory(parent)?;
                    }
                    match fs::symlink_metadata(&link_path) {
                        Ok(metadata)
                            if metadata.file_type().is_symlink()
                                || Self::has_reparse_point(&metadata)
                                || metadata.is_dir() =>
                        {
                            return Err(anyhow!(
                                "Skill ZIP 符号链接目标覆盖了非普通文件: {}",
                                link_path.display()
                            ));
                        }
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                    fs::copy(&resolved, link_path)?;
                } else {
                    return Err(anyhow!("Skill ZIP 符号链接目标不是普通文件或目录"));
                }
                progressed = true;
            }

            if next.is_empty() {
                return Ok(());
            }
            if !progressed {
                return Err(anyhow!("Skill ZIP 包含无法解析或循环符号链接"));
            }
            pending = next;
        }

        Err(anyhow!("Skill ZIP 符号链接解析超过限制"))
    }

    // ========== 从 ZIP 文件安装 ==========

    /// 从本地 ZIP 文件安装 Skills
    ///
    /// 流程：
    /// 1. 解压 ZIP 到临时目录
    /// 2. 扫描目录查找包含 SKILL.md 的技能
    /// 3. 复制到 SSOT 并保存到数据库
    /// 4. 同步到当前应用目录
    pub fn install_from_zip(
        db: &Arc<Database>,
        zip_path: &Path,
        current_app: &AppType,
    ) -> Result<Vec<InstalledSkill>> {
        let temp_dir = Self::extract_local_zip(zip_path)?;
        let skill_dirs = match Self::scan_skills_in_dir(&temp_dir) {
            Ok(dirs) => dirs,
            Err(error) => {
                let _ = Self::remove_path(&temp_dir);
                return Err(error);
            }
        };

        if skill_dirs.is_empty() {
            let _ = Self::remove_path(&temp_dir);
            return Err(anyhow!(format_skill_error(
                "NO_SKILLS_IN_ZIP",
                &[],
                Some("checkZipContent"),
            )));
        }

        let ssot_dir = Self::get_ssot_dir()?;
        let existing_skills = db.get_all_installed_skills()?;
        let zip_stem = zip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let mut seen_names = HashSet::new();
        let mut prepared = Vec::new();

        // 先全量解析和预校验，不在发现后续错误时留下前面已安装的条目。
        for skill_dir in skill_dirs {
            let skill_md = skill_dir.join("SKILL.md");
            let meta = match Self::parse_skill_metadata_static(&skill_md) {
                Ok(meta) => meta,
                Err(error) => {
                    let cleanup_error = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "解析 ZIP 中的 SKILL.md 失败，已尝试清理临时目录（cleanup={cleanup_error:?}）: {error}"
                    ));
                }
            };
            let dir_name = skill_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let install_name =
                if skill_dir == temp_dir || dir_name.is_empty() || dir_name.starts_with('.') {
                    meta.name
                        .as_deref()
                        .and_then(Self::sanitize_install_name)
                        .or_else(|| zip_stem.as_deref().and_then(Self::sanitize_install_name))
                } else {
                    Self::sanitize_install_name(&dir_name)
                        .or_else(|| meta.name.as_deref().and_then(Self::sanitize_install_name))
                        .or_else(|| zip_stem.as_deref().and_then(Self::sanitize_install_name))
                };
            let install_name = match install_name {
                Some(name) => name,
                None => {
                    let _ = Self::remove_path(&temp_dir);
                    return Err(anyhow!(format_skill_error(
                        "INVALID_SKILL_DIRECTORY",
                        &[("zip", &zip_path.display().to_string())],
                        Some("checkZipContent"),
                    )));
                }
            };
            if !seen_names.insert(install_name.to_lowercase()) {
                let _ = Self::remove_path(&temp_dir);
                return Err(anyhow!("ZIP 中包含重复的 Skill 目录: {}", install_name));
            }

            if let Some(existing) = existing_skills
                .values()
                .find(|skill| skill.directory.eq_ignore_ascii_case(&install_name))
            {
                log::warn!(
                    "Skill directory '{}' already exists (from {}), skipping",
                    install_name,
                    existing.id
                );
                continue;
            }

            let dest = ssot_dir.join(&install_name);
            if fs::symlink_metadata(&dest).is_ok() {
                let _ = Self::remove_path(&temp_dir);
                return Err(anyhow!(
                    "Skill 目标目录已存在但没有对应数据库记录，拒绝覆盖: {}",
                    dest.display()
                ));
            }

            let (name, description) = (
                meta.name.unwrap_or_else(|| install_name.clone()),
                meta.description,
            );
            prepared.push(PreparedZipSkill {
                source: skill_dir,
                install_name,
                name,
                description,
            });
        }

        if prepared.is_empty() {
            let _ = Self::remove_path(&temp_dir);
            return Ok(Vec::new());
        }

        let batch_dir = tempfile::Builder::new()
            .prefix(".chimera-skill-batch-")
            .tempdir_in(&ssot_dir)?;
        let batch_root = batch_dir.keep();
        let mut staged = Vec::new();
        for item in prepared {
            let stage = batch_root.join(&item.install_name);
            if let Err(error) = Self::copy_dir_recursive(&item.source, &stage) {
                let _ = Self::remove_path(&batch_root);
                let _ = Self::remove_path(&temp_dir);
                return Err(error);
            }
            staged.push((item, stage));
        }

        let mut committed: Vec<(InstalledSkill, PathBuf)> = Vec::new();
        let rollback = |committed: &[(InstalledSkill, PathBuf)]| -> Vec<String> {
            let mut errors = Vec::new();
            for (skill, dest) in committed {
                if let Err(error) = db.delete_skill(&skill.id) {
                    errors.push(format!("db {}: {error}", skill.id));
                }
                if let Err(error) = Self::remove_path(dest) {
                    errors.push(format!("ssot {}: {error}", dest.display()));
                }
                if let Err(error) = Self::remove_from_app(&skill.directory, current_app) {
                    errors.push(format!("app {}: {error}", skill.directory));
                }
            }
            errors
        };

        for (item, stage) in staged {
            let dest = ssot_dir.join(&item.install_name);
            if let Err(error) = Self::commit_new_directory(&stage, &dest) {
                let rollback_errors = rollback(&committed);
                let batch_cleanup = Self::remove_path(&batch_root).err();
                let temp_cleanup = Self::remove_path(&temp_dir).err();
                return Err(anyhow!(
                    "提交批量安装的 Skill 目录失败，已尝试回滚（rollback={rollback_errors:?}, batch_cleanup={batch_cleanup:?}, temp_cleanup={temp_cleanup:?}）: {error}"
                ));
            }

            let content_hash = match Self::compute_dir_hash(&dest) {
                Ok(hash) => Some(hash),
                Err(error) => {
                    let ssot_cleanup = Self::remove_path(&dest).err();
                    let rollback_errors = rollback(&committed);
                    let batch_cleanup = Self::remove_path(&batch_root).err();
                    let temp_cleanup = Self::remove_path(&temp_dir).err();
                    return Err(anyhow!(
                        "批量安装 Skill 后计算内容哈希失败，已尝试回滚（ssot_cleanup={ssot_cleanup:?}, rollback={rollback_errors:?}, batch_cleanup={batch_cleanup:?}, temp_cleanup={temp_cleanup:?}）: {error}"
                    ));
                }
            };

            let skill = InstalledSkill {
                id: format!("local:{}", item.install_name),
                name: item.name,
                description: item.description,
                directory: item.install_name,
                repo_owner: None,
                repo_name: None,
                repo_branch: None,
                readme_url: None,
                apps: SkillApps::only(current_app),
                installed_at: chrono::Utc::now().timestamp(),
                content_hash,
                updated_at: 0,
            };

            if let Err(error) = db.save_skill(&skill) {
                let ssot_cleanup = Self::remove_path(&dest).err();
                let rollback_errors = rollback(&committed);
                let batch_cleanup = Self::remove_path(&batch_root).err();
                let temp_cleanup = Self::remove_path(&temp_dir).err();
                return Err(anyhow!(
                    "保存批量安装的 Skill 记录失败，已尝试回滚（ssot_cleanup={ssot_cleanup:?}, rollback={rollback_errors:?}, batch_cleanup={batch_cleanup:?}, temp_cleanup={temp_cleanup:?}）: {error}"
                ));
            }
            committed.push((skill, dest));
        }

        let mut installed = Vec::with_capacity(committed.len());
        for (skill, _) in &committed {
            if let Err(error) = Self::sync_to_app_dir(&skill.directory, current_app) {
                let rollback_errors = rollback(&committed);
                let batch_cleanup = Self::remove_path(&batch_root).err();
                let temp_cleanup = Self::remove_path(&temp_dir).err();
                return Err(anyhow!(
                    "批量安装 Skill 同步失败，已尝试回滚（rollback={rollback_errors:?}, batch_cleanup={batch_cleanup:?}, temp_cleanup={temp_cleanup:?}）: {error}"
                ));
            }
            log::info!(
                "Skill {} installed from ZIP, enabled for {:?}",
                skill.name,
                current_app
            );
            installed.push(skill.clone());
        }

        let _ = Self::remove_path(&batch_root);
        let _ = Self::remove_path(&temp_dir);
        Ok(installed)
    }

    /// 解压本地 ZIP 文件到临时目录。
    fn extract_local_zip(zip_path: &Path) -> Result<PathBuf> {
        let file = fs::File::open(zip_path)
            .with_context(|| format!("Failed to open ZIP file: {}", zip_path.display()))?;
        let temp_dir = tempfile::tempdir()?;
        let temp_path = temp_dir.path().to_path_buf();

        if let Err(error) = Self::extract_zip_archive(file, &temp_path, false) {
            let _ = Self::remove_path(&temp_path);
            return Err(error)
                .with_context(|| format!("Failed to extract ZIP file: {}", zip_path.display()));
        }

        let kept_path = temp_dir.keep();
        Ok(kept_path)
    }

    /// 递归扫描目录查找包含 SKILL.md 的技能目录。
    ///
    /// 扫描只接受普通目录/普通文件，不跟随符号链接或 junction，并限制
    /// 递归深度、目录数量和发现数量，避免恶意 ZIP 造成资源消耗或路径逃逸。
    fn scan_skills_in_dir(dir: &Path) -> Result<Vec<PathBuf>> {
        let mut skill_dirs = Vec::new();
        let mut directories = 0usize;
        Self::scan_skills_recursive_with_budget(dir, &mut skill_dirs, &mut directories, 0)?;
        Ok(skill_dirs)
    }

    fn scan_skills_recursive_with_budget(
        current: &Path,
        results: &mut Vec<PathBuf>,
        directories: &mut usize,
        depth: usize,
    ) -> Result<()> {
        let current_metadata = fs::symlink_metadata(current)
            .with_context(|| format!("读取 Skill 扫描目录失败: {}", current.display()))?;
        if current_metadata.file_type().is_symlink()
            || Self::has_reparse_point(&current_metadata)
            || !current_metadata.is_dir()
        {
            return Err(anyhow!("Skill 扫描路径不是普通目录: {}", current.display()));
        }
        if depth > MAX_SKILL_DIRECTORY_DEPTH {
            return Err(anyhow!(
                "Skill ZIP 目录递归深度超过限制（最多 {} 层）: {}",
                MAX_SKILL_DIRECTORY_DEPTH,
                current.display()
            ));
        }
        *directories = (*directories)
            .checked_add(1)
            .ok_or_else(|| anyhow!("Skill ZIP 目录数量溢出"))?;
        if *directories > MAX_SKILL_DIRECTORIES {
            return Err(anyhow!(
                "Skill ZIP 目录数量超过限制（最多 {} 个）",
                MAX_SKILL_DIRECTORIES
            ));
        }
        if current.to_string_lossy().len() > MAX_SKILL_PATH_BYTES {
            return Err(anyhow!("Skill ZIP 扫描路径过长: {}", current.display()));
        }

        let skill_md = current.join("SKILL.md");
        let skill_md_metadata = match fs::symlink_metadata(&skill_md) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("读取 Skill ZIP 的 SKILL.md 失败: {}", skill_md.display())
                })
            }
        };
        if let Some(metadata) = skill_md_metadata {
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "Skill ZIP 的 SKILL.md 不能是符号链接: {}",
                    skill_md.display()
                ));
            }
            if metadata.is_file() {
                if results.len() >= MAX_DISCOVERED_SKILLS {
                    return Err(anyhow!(
                        "ZIP 中发现的 Skill 数量超过限制（最多 {} 个）",
                        MAX_DISCOVERED_SKILLS
                    ));
                }
                results.push(current.to_path_buf());
                // 找到后不再递归子目录（一个 skill 目录）。
                return Ok(());
            }
            return Err(anyhow!(
                "Skill ZIP 的 SKILL.md 不是普通文件: {}",
                skill_md.display()
            ));
        }

        let entries = fs::read_dir(current)
            .with_context(|| format!("读取 Skill 扫描目录失败: {}", current.display()))?;
        for entry in entries {
            let entry = entry?;
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("读取 Skill 扫描条目失败: {}", path.display()))?;
            if metadata.file_type().is_symlink() || Self::has_reparse_point(&metadata) {
                return Err(anyhow!(
                    "Skill ZIP 扫描遇到符号链接或 junction: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                Self::scan_skills_recursive_with_budget(&path, results, directories, depth + 1)?;
            }
        }

        Ok(())
    }

    // ========== 仓库管理（保留原有逻辑）==========

    /// 列出仓库
    pub fn list_repos(&self, store: &SkillStore) -> Vec<SkillRepo> {
        store.repos.clone()
    }

    /// 添加仓库
    pub fn add_repo(&self, store: &mut SkillStore, repo: SkillRepo) -> Result<()> {
        if let Some(pos) = store
            .repos
            .iter()
            .position(|r| r.owner == repo.owner && r.name == repo.name)
        {
            store.repos[pos] = repo;
        } else {
            store.repos.push(repo);
        }

        Ok(())
    }

    /// 删除仓库
    pub fn remove_repo(&self, store: &mut SkillStore, owner: String, name: String) -> Result<()> {
        store
            .repos
            .retain(|r| !(r.owner == owner && r.name == name));

        Ok(())
    }

    // ========== skills.sh 搜索 ==========

    /// 搜索 skills.sh 公共目录
    pub async fn search_skills_sh(
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<SkillsShSearchResult> {
        let client = crate::proxy::http_client::get();

        let url = url::Url::parse_with_params(
            "https://skills.sh/api/search",
            &[
                ("q", query),
                ("limit", &limit.to_string()),
                ("offset", &offset.to_string()),
            ],
        )?;

        let resp = client
            .get(url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json::<SkillsShApiResponse>()
            .await?;

        let skills = resp
            .skills
            .into_iter()
            .filter_map(|s| {
                let parts: Vec<&str> = s.source.splitn(2, '/').collect();
                if parts.len() != 2 {
                    return None;
                }
                let (owner, repo) = (parts[0].to_string(), parts[1].to_string());
                // 过滤非 GitHub 来源（如 "skills.volces.com"、"mcp-hub.momenta.works"）
                if owner.contains('.') || repo.contains('.') {
                    return None;
                }
                Some(SkillsShDiscoverableSkill {
                    key: s.id,
                    name: s.name,
                    directory: s.skill_id.clone(),
                    repo_owner: owner.clone(),
                    repo_name: repo.clone(),
                    repo_branch: "main".to_string(),
                    installs: s.installs,
                    readme_url: Some(format!("https://github.com/{}/{}", owner, repo)),
                })
            })
            .collect();

        Ok(SkillsShSearchResult {
            skills,
            total_count: resp.count,
            query: resp.query,
        })
    }
}

// ========== 迁移支持 ==========

/// 从 lock 文件信息构建 skill 的 ID、仓库字段和 readme URL
///
/// 返回 (id, repo_owner, repo_name, repo_branch, readme_url)
fn build_repo_info_from_lock(
    lock: &HashMap<String, LockRepoInfo>,
    dir_name: &str,
) -> (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    match lock.get(dir_name) {
        Some(info) => {
            let branch = info.branch.clone();
            let url_branch = branch.clone().unwrap_or_else(|| "HEAD".to_string());
            // 优先使用 lock 文件中的 skillPath，否则回退到 dir_name/SKILL.md
            let fallback = format!("{dir_name}/SKILL.md");
            let doc_path = info.skill_path.as_deref().unwrap_or(&fallback);
            let url = Some(SkillService::build_skill_doc_url(
                &info.owner,
                &info.repo,
                &url_branch,
                doc_path,
            ));
            (
                format!("{}/{}:{dir_name}", info.owner, info.repo),
                Some(info.owner.clone()),
                Some(info.repo.clone()),
                branch,
                url,
            )
        }
        None => (format!("local:{dir_name}"), None, None, None, None),
    }
}

/// 将 lock 文件中发现的仓库转换为去重后的数据库记录。
fn repos_from_lock(
    lock: &HashMap<String, LockRepoInfo>,
    directories: impl Iterator<Item = impl AsRef<str>>,
) -> Vec<SkillRepo> {
    let mut repos = Vec::new();
    let mut added = HashSet::new();

    for dir_name in directories {
        if let Some(info) = lock.get(dir_name.as_ref()) {
            let key = (info.owner.clone(), info.repo.clone());
            if added.insert(key) {
                repos.push(SkillRepo {
                    owner: info.owner.clone(),
                    name: info.repo.clone(),
                    // 未知分支时使用 HEAD 语义，后续下载会回退到 main/master。
                    branch: info.branch.clone().unwrap_or_else(|| "HEAD".to_string()),
                    enabled: true,
                });
            }
        }
    }

    repos
}

/// 首次启动迁移：扫描应用目录，重建数据库
pub fn migrate_skills_to_ssot(db: &Arc<Database>) -> Result<usize> {
    let ssot_dir = SkillService::get_ssot_dir()?;
    let mut created_ssot_paths = Vec::new();

    let result: Result<usize> = (|| {
        let agents_lock = parse_agents_lock();
        let (has_snapshot, snapshot): (bool, Vec<LegacySkillMigrationRow>) = match db
            .get_setting("skills_ssot_migration_snapshot")?
        {
            Some(value) if !value.trim().is_empty() => (
                true,
                serde_json::from_str(&value)
                    .with_context(|| "解析 skills 迁移快照失败；拒绝在快照损坏时重构用户选择")?,
            ),
            _ => (false, Vec::new()),
        };
        let mut discovered: HashMap<String, SkillApps> = HashMap::new();

        if has_snapshot {
            for row in &snapshot {
                SkillService::validate_managed_skill_directory(&row.directory)
                    .with_context(|| format!("迁移快照包含非法 Skill 目录: {}", row.directory))?;
                let app = row
                    .app_type
                    .parse::<AppType>()
                    .with_context(|| format!("迁移快照包含未知应用类型: {}", row.app_type))?;
                discovered
                    .entry(row.directory.clone())
                    .or_default()
                    .set_enabled_for(&app, true);
            }
        }

        // 扫描各应用目录；目录读取和结构检查失败时终止迁移，不能静默漏掉 Skill。
        for app in AppType::all() {
            let app_dir = SkillService::get_app_skills_dir(&app)
                .with_context(|| format!("解析 {:?} Skill 目录失败", app))?;

            if !SkillService::normal_directory_exists(&app_dir)? {
                continue;
            }
            let entries = fs::read_dir(&app_dir)
                .with_context(|| format!("读取 {:?} Skill 目录失败: {}", app, app_dir.display()))?;

            for entry in entries {
                let entry = entry.with_context(|| {
                    format!("遍历 {:?} Skill 目录失败: {}", app, app_dir.display())
                })?;
                let path = entry.path();
                if !SkillService::normal_directory_exists(&path)? {
                    continue;
                }

                let dir_name = entry.file_name().to_string_lossy().to_string();
                if dir_name.starts_with('.')
                    || SkillService::validate_managed_skill_directory(&dir_name).is_err()
                {
                    continue;
                }
                if !SkillService::normal_file_exists(&path.join("SKILL.md"))? {
                    continue;
                }
                if has_snapshot && !discovered.contains_key(&dir_name) {
                    continue;
                }

                // 复制到 SSOT；失败时由外层统一清理本次新建目录。
                let ssot_path = ssot_dir.join(&dir_name);
                if !SkillService::normal_directory_exists(&ssot_path)? {
                    created_ssot_paths.push(ssot_path.clone());
                    SkillService::copy_dir_recursive(&path, &ssot_path).with_context(|| {
                        format!("迁移 Skill 到 SSOT 失败: {}", ssot_path.display())
                    })?;
                }

                if !has_snapshot {
                    discovered
                        .entry(dir_name)
                        .or_default()
                        .set_enabled_for(&app, true);
                }
            }
        }

        // 先完成所有目录、元数据和哈希校验，再修改数据库；避免清空数据库后中途失败。
        let mut rebuilt_skills = Vec::with_capacity(discovered.len());
        for (directory, apps) in &discovered {
            let ssot_path = ssot_dir.join(directory);
            let skill_md = ssot_path.join("SKILL.md");

            let (name, description) =
                SkillService::read_skill_name_desc_strict(&skill_md, directory)?;
            let (id, repo_owner, repo_name, repo_branch, readme_url) =
                build_repo_info_from_lock(&agents_lock, directory);
            let content_hash = SkillService::compute_dir_hash(&ssot_path).map_err(|error| {
                anyhow!(
                    "迁移 Skill 时计算内容哈希失败: {}: {error}",
                    ssot_path.display()
                )
            })?;

            rebuilt_skills.push(InstalledSkill {
                id,
                name,
                description,
                directory: directory.clone(),
                repo_owner,
                repo_name,
                repo_branch,
                readme_url,
                apps: apps.clone(),
                installed_at: chrono::Utc::now().timestamp(),
                content_hash: Some(content_hash),
                updated_at: 0,
            });
        }

        let repos = repos_from_lock(
            &agents_lock,
            discovered.keys().map(|directory| directory.as_str()),
        );
        db.apply_skills_and_repos_atomic(
            &rebuilt_skills,
            &repos,
            true,
            Some("skills_ssot_migration_snapshot"),
        )
        .context("提交 Skills 迁移事务失败")?;

        Ok(rebuilt_skills.len())
    })();

    match result {
        Ok(count) => {
            log::info!("Skills 迁移完成，共 {count} 个");
            Ok(count)
        }
        Err(error) => {
            let cleanup_errors = SkillService::cleanup_paths(&created_ssot_paths);
            if cleanup_errors.is_empty() {
                Err(error)
            } else {
                Err(anyhow!(
                    "Skills 迁移失败: {error}；清理新 SSOT 时另有失败: {}",
                    cleanup_errors.join("; ")
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_skill(dir: &Path, name: &str) {
        fs::create_dir_all(dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test skill\n---\n"),
        )
        .expect("write SKILL.md");
    }

    #[test]
    // serial：与 backup/s3_sync/deeplink 等同样读写进程级 CC_SWITCH_TEST_HOME 的测试互斥，
    // EnvGuard 只负责恢复不提供互斥。
    #[serial_test::serial]
    fn get_app_skills_dir_honors_test_home_override() {
        // 回归：曾直呼 dirs::home_dir() 绕过 CC_SWITCH_TEST_HOME——Unix 上碰巧跟 $HOME
        // 一致所以测试能过，Windows 上 dirs 走 Known Folder API，测试隔离整体失效
        // （tests/skill_sync.rs 扫到 runner 真实用户目录）。
        struct EnvGuard(Option<std::ffi::OsString>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                    None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
                }
            }
        }
        let temp = tempdir().expect("tempdir");
        let _guard = EnvGuard(std::env::var_os("CC_SWITCH_TEST_HOME"));
        std::env::set_var("CC_SWITCH_TEST_HOME", temp.path());

        let dir =
            SkillService::get_app_skills_dir(&AppType::Claude).expect("resolve claude skills dir");
        assert!(
            dir.starts_with(temp.path()),
            "skills dir must live under the overridden test home, got {}",
            dir.display()
        );
    }

    #[test]
    fn resolve_skill_source_dir_returns_repo_root_for_root_level_skill() {
        let temp = tempdir().expect("tempdir");
        write_skill(temp.path(), "Root Skill");

        let resolved =
            SkillService::resolve_skill_source_dir_checked(temp.path(), "last30days-skill-cn")
                .expect("root-level source lookup should not fail")
                .expect("root-level skill should resolve to the extracted repo root");

        assert_eq!(resolved, temp.path());
    }

    #[test]
    fn resolve_skill_source_dir_returns_direct_nested_directory_when_present() {
        let temp = tempdir().expect("tempdir");
        let nested = temp.path().join("skills").join("nested-skill");
        write_skill(&nested, "Nested Skill");

        let resolved =
            SkillService::resolve_skill_source_dir_checked(temp.path(), "skills/nested-skill")
                .expect("nested source lookup should not fail")
                .expect("nested skill should resolve from its relative source path");

        assert_eq!(resolved, nested);
    }

    #[test]
    fn resolve_skill_source_dir_falls_back_to_matching_install_name() {
        let temp = tempdir().expect("tempdir");
        let nested = temp.path().join("skills").join("nested-skill");
        write_skill(&nested, "Nested Skill");

        let resolved = SkillService::resolve_skill_source_dir_checked(temp.path(), "nested-skill")
            .expect("fallback source lookup should not fail")
            .expect("install name should fall back to the matching discovered skill directory");

        assert_eq!(resolved, nested);
    }

    #[test]
    fn backup_path_for_id_rejects_root_and_path_like_ids() {
        for invalid in [".", "..", "", " ", "foo/bar", "foo\\bar", "foo:bar", "foo."] {
            assert!(
                SkillService::backup_path_for_id(invalid).is_err(),
                "backup id should be rejected: {invalid:?}"
            );
        }
    }

    #[test]
    fn replace_dest_with_copy_rejects_empty_source_without_touching_existing_dest() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source-skill");
        let dest = temp.path().join("app-skills").join("source-skill");
        fs::create_dir_all(&source).expect("create empty source");
        write_skill(&dest, "Existing Skill");

        let err = SkillService::replace_dest_with_copy(&source, &dest, "source-skill")
            .expect_err("empty source should not replace existing app skill");

        assert!(
            err.to_string().contains("SKILL.md"),
            "unexpected error: {err:#}"
        );
        assert!(
            dest.join("SKILL.md").is_file(),
            "existing destination skill should be preserved"
        );
    }
}
