//! Read-only Codex diagnostics and explicitly confirmed owned-reference repair.
//! Reports never expose raw config values or user-defined table names.
//! Provider rules adapted from yynxxxxx/Codex-X (MIT),
//! apps/desktop/src-tauri/src/config_health.rs at
//! 8f018fddd3ee1a68464e4df8765eb370ede0c76f. Line/column location and the
//! syntax-error categories are adapted from the same file at
//! 19222f9cc92e3111e47f2a6bbc7db6ed2cc9c462 (commit 5a9ec05), without its
//! key-path echo; the legacy `[tui]` prompt rule follows its
//! config_migration.rs at the same revision, detection only.
use crate::security_limits::{read_limited, ResourceLimitError, MAX_CONFIG_FILE_BYTES};
use serde::Serialize;
use std::io::ErrorKind;
use std::path::Path;
use toml_edit::{ImDocument, Item, Key, Table, TableLike};

const CONFIG: &str = "config.toml";
const AUTH: &str = "auth.json";
const BUILTIN_PROVIDERS: [&str; 5] = [
    "openai",
    "ollama",
    "lmstudio",
    "amazon-bedrock",
    "amazon-bedrock-runtime",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    id: String,
    severity: &'static str,
    title: &'static str,
    location: &'static str,
    impact: String,
    solution: &'static str,
    repairable: bool,
    /// 1-based line of the parameter in config.toml.
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<usize>,
    /// 1-based column in Unicode characters, as an editor counts them.
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<usize>,
    /// A Codex schema key name; never a user-defined table name or a value.
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'static str>,
    /// Key path used only to find the line. It can hold user-defined provider
    /// or profile names, so it is never serialized.
    #[serde(skip)]
    anchor: Option<Vec<String>>,
    /// A dangling instruction reference: the owned-reference repair removes it
    /// whenever that repair is offered.
    #[serde(skip)]
    repair_candidate: bool,
}

impl HealthIssue {
    /// Point the issue at a parameter. `path` may contain user-defined names.
    fn at(&mut self, path: &[&str], field: Option<&'static str>) -> &mut Self {
        self.anchor = Some(path.iter().map(|&part| part.to_owned()).collect());
        self.field = field;
        self
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    issues: Vec<HealthIssue>,
    checked_at: String,
    read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repair_token: Option<String>,
}

impl HealthReport {
    fn issue(
        &mut self,
        code: &str,
        severity: &'static str,
        title: &'static str,
        location: &'static str,
        impact: impl Into<String>,
        solution: &'static str,
    ) -> &mut HealthIssue {
        let index = self.issues.len();
        self.issues.push(HealthIssue {
            id: format!("{code}-{index}"),
            severity,
            title,
            location,
            impact: impact.into(),
            solution,
            repairable: false,
            line: None,
            column: None,
            field: None,
            anchor: None,
            repair_candidate: false,
        });
        &mut self.issues[index]
    }
}

pub fn check() -> HealthReport {
    check_paths(
        &crate::codex_config::get_codex_config_path(),
        &crate::codex_config::get_codex_auth_path(),
    )
}

/// A preview identifies both the original bytes and the exact proposed edit.
/// No renderer-controlled paths or replacement content are ever accepted.
fn repair_preview(text: &str) -> Result<Option<(String, String)>, crate::error::AppError> {
    use sha2::{Digest, Sha256};
    crate::codex_config::validate_config_toml(text)?;
    let next = crate::codex_live_write::validate_instruction_refs(text)?;
    if next == text {
        return Ok(None);
    }
    // Do not silently bundle unrelated settings cleanup into this narrow repair.
    if crate::codex_config::strip_rejected_codex_settings(&next)? != next {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    digest.update(Sha256::digest(text.as_bytes()));
    digest.update(Sha256::digest(next.as_bytes()));
    Ok(Some((format!("{:x}", digest.finalize()), next)))
}

pub fn repair_owned_instruction_refs(
    state: &crate::store::AppState,
    expected_token: &str,
) -> Result<HealthReport, crate::error::AppError> {
    use crate::{app_config::AppType, config::cas::FileSnapshot, error::AppError};
    if expected_token.len() != 64 || !expected_token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "修复确认已失效，请重新检查。".into(),
        ));
    }
    let _guard = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
    if futures::executor::block_on(state.db.get_live_backup("codex"))?.is_some()
        || state
            .proxy_service
            .detect_takeover_in_live_config_for_app(&AppType::Codex)
    {
        return Err(AppError::InvalidInput(
            "请先关闭 Codex 代理接管再修复配置。".into(),
        ));
    }
    let snapshot = FileSnapshot::read(crate::codex_config::get_codex_config_path())?;
    let text = std::str::from_utf8(snapshot.contents().unwrap_or_default())
        .map_err(|_| AppError::InvalidInput("配置必须使用 UTF-8 编码。".into()))?;
    let (token, next) = repair_preview(text)?
        .ok_or_else(|| AppError::InvalidInput("修复方案已变化，请重新检查。".into()))?;
    if token != expected_token {
        return Err(AppError::InvalidInput(
            "配置已变化，请重新检查后确认。".into(),
        ));
    }
    crate::services::live_backup::create_config_repair_backup(&state.db, &snapshot)?;
    crate::codex_live_write::plan_observed_config(snapshot, &next)?.commit()?;
    Ok(check())
}

fn check_paths(config: &Path, auth: &Path) -> HealthReport {
    let mut report = HealthReport {
        issues: vec![],
        checked_at: chrono::Utc::now().to_rfc3339(),
        read_only: true,
        repair_token: None,
    };
    match read_limited(config, MAX_CONFIG_FILE_BYTES) {
        Ok(bytes) => match std::str::from_utf8(&bytes) {
            Ok(text) => check_config_text(config, text, &mut report),
            Err(_) => {
                report.issue(
                    "encoding",
                    "critical",
                    "配置编码不正确",
                    CONFIG,
                    "配置必须使用 UTF-8 编码，Codex 无法读取其他编码。",
                    "用文本编辑器把 config.toml 另存为 UTF-8 编码后重新检查。",
                );
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            report.issue(
                "missing",
                "warning",
                "尚未创建 Codex 配置",
                CONFIG,
                "首次使用时可以通过线路页面配置。",
                "在「线路」页添加线路后会自动生成。",
            );
        }
        Err(error) => read_failure(&mut report, CONFIG, &error),
    }
    match read_limited(auth, MAX_CONFIG_FILE_BYTES) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => {}
            _ => {
                report.issue(
                    "auth-format",
                    "critical",
                    "登录配置格式不正确",
                    AUTH,
                    "登录配置必须是 JSON 对象；未回显凭据内容。",
                    "在「官方账号」页重新登录会重新生成 auth.json；不使用官方账号时，可删除该文件后重新检查。",
                );
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            report.issue(
                "auth-missing",
                "warning",
                "未发现登录配置",
                AUTH,
                "使用环境变量认证时可以没有此文件；官方账户可通过登录流程创建。",
                "登录官方账号后会自动生成；使用 API 密钥的线路不需要它。",
            );
        }
        Err(error) => read_failure(&mut report, AUTH, &error),
    }
    report
}

fn check_config_text(config: &Path, text: &str, report: &mut HealthReport) {
    let source = match ImDocument::parse(text) {
        Ok(source) => source,
        Err(error) => {
            // Parser messages can quote whole source lines, API keys included:
            // keep only the position and a category of the message.
            let issue = report.issue(
                "toml",
                "critical",
                "配置语法不正确",
                CONFIG,
                "Codex 会拒绝加载整份配置；未显示文件内容。",
                syntax_suggestion(error.message()),
            );
            if let Some(span) = error.span() {
                let (line, column) = line_column(text, span.start);
                issue.line = Some(line);
                issue.column = Some(column);
            }
            return;
        }
    };
    analyze(
        source.as_table(),
        config.parent().unwrap_or(Path::new(".")),
        report,
    );
    for issue in &mut report.issues {
        let offset = issue
            .anchor
            .as_deref()
            .and_then(|path| key_offset(source.as_table(), path));
        if let Some(offset) = offset {
            let (line, column) = line_column(text, offset);
            issue.line = Some(line);
            issue.column = Some(column);
        }
    }
    if config == crate::codex_config::get_codex_config_path() {
        if let Ok(Some((token, _))) = repair_preview(text) {
            report.repair_token = Some(token);
            // A token means no external reference dangles, so every dangling
            // instruction reference is ours and the repair removes it.
            for issue in &mut report.issues {
                issue.repairable = issue.repair_candidate;
            }
        }
    }
}

/// Byte offset of the parameter (or table) at `path`, from the parser spans.
fn key_offset(root: &Table, path: &[String]) -> Option<usize> {
    let (last, parents) = path.split_last()?;
    let mut table: &dyn TableLike = root;
    for part in parents {
        table = table.get(part)?.as_table_like()?;
    }
    table
        .key(last)
        .and_then(Key::span)
        .or_else(|| table.get(last).and_then(Item::span))
        .map(|span| span.start)
}

fn line_column(text: &str, offset: usize) -> (usize, usize) {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let prefix = &text[..offset];
    let line = prefix.matches('\n').count() + 1;
    let current = prefix.rsplit('\n').next().unwrap_or_default();
    // Editors do not show a byte-order mark, so it takes no column.
    let column = current.trim_start_matches('\u{feff}').chars().count() + 1;
    (line, column)
}

/// Map a parser message to advice. Only categories leave this function: the
/// message itself may name user keys.
fn syntax_suggestion(message: &str) -> &'static str {
    if message.contains("duplicate") {
        "同一张表里有重复的参数或表头；只保留一处定义，合并需要的内容后重新检查。"
    } else if message.contains("extend") {
        "同一个名称既被写成参数又被用作表；保留其中一种写法后重新检查。"
    } else if message.contains("escape") || message.contains("unicode") {
        "双引号里的反斜杠 \\ 表示转义；Windows 路径请改用单引号，或把每个 \\ 写成 \\\\。"
    } else if message.contains("inline table") {
        "花括号 { } 里的内联表要写在同一行，以 } 结束，各项之间用逗号分隔。"
    } else if message.contains("table") {
        "检查表头的方括号与点分名称，例如 [model_providers.名称]；同一张表不能重复定义。"
    } else if message.contains("array") {
        "检查数组是否以 ] 结束，各元素之间是否有逗号。"
    } else if message.contains("invalid string") {
        "文字值需要加引号，例如 model = \"名称\"；等号后面不能为空。"
    } else if message.contains("string") || message.contains("quote") {
        "检查引号是否成对；单行文字不能直接换行，需要换行时使用三引号。"
    } else if message.contains("`=`") {
        "参数要写成 参数名 = 值；补上等号后重新检查。"
    } else if message.contains("newline") {
        "每行只写一个 参数名 = 值；值后面多出的内容请删除，或用 # 开头写成注释。"
    } else if message.contains("integer")
        || message.contains("floating-point")
        || message.contains("date")
        || message.contains("time")
    {
        "检查数字或日期的写法；文字值需要加引号。"
    } else if message.contains("key") {
        "参数名只能包含字母、数字、- 和 _；含其他字符时给参数名加上引号。"
    } else {
        "检查标记位置附近的引号、逗号和括号是否配对，参数应写成 参数名 = 值。"
    }
}

fn limit_error(error: &std::io::Error) -> Option<&ResourceLimitError> {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ResourceLimitError>())
}

/// Say why config.toml or auth.json could not be read, instead of one shared
/// sentence. Reads never follow a final link, by design.
fn read_failure(report: &mut HealthReport, file: &'static str, error: &std::io::Error) {
    let config = file == CONFIG;
    let pick = |config_text: &'static str, auth_text: &'static str| {
        if config {
            config_text
        } else {
            auth_text
        }
    };
    let (code, title, impact, solution) = match limit_error(error) {
        Some(ResourceLimitError::Symlink) => (
            pick("linked", "auth-linked"),
            pick("config.toml 是链接文件", "auth.json 是链接文件"),
            "它是符号链接或重解析点。Chimera++ 不会跟随链接读写，因此无法检查或写入这个文件。",
            "请到链接指向的原文件中修改，或改用普通文件后重新检查。",
        ),
        Some(ResourceLimitError::TooLarge { .. }) => (
            pick("too-large", "auth-too-large"),
            pick("config.toml 过大", "auth.json 过大"),
            "文件超过 8 MiB 上限，未读取。",
            "删除误粘贴的大段内容，使文件小于 8 MiB 后重新检查。",
        ),
        None if error.kind() == ErrorKind::PermissionDenied => (
            pick("permission", "auth-permission"),
            pick("无权读取 config.toml", "无权读取 auth.json"),
            "当前用户没有读取这个文件的权限。",
            "在文件属性的「安全」中为当前用户授予读取权限，或关闭占用它的程序后重新检查。",
        ),
        None if error.kind() == ErrorKind::InvalidInput => (
            pick("not-file", "auth-not-file"),
            pick("config.toml 不是普通文件", "auth.json 不是普通文件"),
            "这个位置是文件夹或特殊文件。",
            pick(
                "移走这个位置上的文件夹，再在「线路」页重新应用线路以生成配置。",
                "移走这个位置上的文件夹，再在「官方账号」页重新登录。",
            ),
        ),
        None => (
            pick("unreadable", "auth-unreadable"),
            pick("无法安全读取配置", "无法安全读取登录配置"),
            "读取时出错；未读取文件内容。",
            "确认文件没有被其他程序锁定后重新检查。",
        ),
    };
    report.issue(code, "critical", title, file, impact, solution);
}

fn analyze(root: &Table, base: &Path, report: &mut HealthReport) {
    let providers = root.get("model_providers").and_then(Item::as_table_like);
    if root.get("model_providers").is_some() && providers.is_none() {
        report
            .issue(
                "providers-type",
                "critical",
                "供应商集合格式不正确",
                CONFIG,
                "model_providers 必须是配置表，Codex 无法从中读取线路。",
                "用 [model_providers.名称] 表头分别写每条线路，不要直接给 model_providers 赋值。",
            )
            .at(&["model_providers"], Some("model_providers"));
    }
    for key in ["model_provider", "model", "profile"] {
        if root
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            report
                .issue(
                    "selector-type",
                    "critical",
                    "模型或线路选择格式不正确",
                    CONFIG,
                    "模型、供应商与配置档选择器必须是非空文字。",
                    "把这一项写成带引号的非空文字，或删除这一行后在「线路」页重新应用线路。",
                )
                .at(&[key], Some(key));
        }
    }
    if let Some(selected) = root
        .get("model_provider")
        .and_then(Item::as_str)
        .filter(|selected| !selected.trim().is_empty())
    {
        if !BUILTIN_PROVIDERS.contains(&selected)
            && !providers.is_some_and(|p| p.contains_key(selected))
        {
            report
                .issue(
                    "provider-missing",
                    "critical",
                    "选用的供应商缺少配置",
                    CONFIG,
                    "当前供应商标识在配置中不存在，Codex 无法发出请求。",
                    "在「线路」页重新启用一条线路；手动编辑时，补上与 model_provider 同名的 [model_providers] 表。",
                )
                .at(&["model_provider"], Some("model_provider"));
        }
    }
    // Codex 0.157 refuses the whole file for any root `profile` (codex-rs
    // core/src/config/mod.rs), whether or not the profile exists.
    if root
        .get("profile")
        .and_then(Item::as_str)
        .is_some_and(|selected| !selected.trim().is_empty())
    {
        report
            .issue(
                "profile-legacy",
                "critical",
                "根级 profile 设置已不受支持",
                CONFIG,
                "当前 Codex 遇到根级 profile 会拒绝加载整份配置。",
                "删除这一行；需要配置档时改用 codex --profile 启动。Chimera++ 下次写入配置时也会移除它。",
            )
            .at(&["profile"], Some("profile"));
    }
    if let Some(providers) = providers {
        for (id, item) in providers.iter() {
            let Some(table) = item.as_table_like() else {
                report
                    .issue(
                        "provider-type",
                        "critical",
                        "供应商配置格式不正确",
                        CONFIG,
                        "有一条供应商配置不是配置表。",
                        "把这一项改成 [model_providers.名称] 表，或删除它。",
                    )
                    .at(&["model_providers", id], None);
                continue;
            };
            if !matches!(id, "amazon-bedrock" | "amazon-bedrock-runtime")
                && table
                    .get("name")
                    .and_then(Item::as_str)
                    .is_none_or(|s| s.trim().is_empty())
            {
                let issue = report.issue(
                    "provider-name",
                    "critical",
                    "供应商缺少有效名称",
                    CONFIG,
                    "供应商名称必须是非空文字。",
                    "在这张供应商表里填写 name = \"显示名称\"（带引号的文字）。",
                );
                // Without a `name` line, point at the table that lacks it.
                if table.contains_key("name") {
                    issue.at(&["model_providers", id, "name"], Some("name"));
                } else {
                    issue.at(&["model_providers", id], Some("name"));
                }
            }
            for (key, solution) in [
                (
                    "base_url",
                    "把 base_url 写成带引号的接口地址，例如 \"https://example.com/v1\"。",
                ),
                (
                    "env_key",
                    "把 env_key 写成带引号的环境变量名，例如 \"MY_API_KEY\"。",
                ),
                (
                    "experimental_bearer_token",
                    "把密钥写成带引号的文字；也可以在「线路」页编辑并保存这条线路来重新写入。",
                ),
            ] {
                if table.get(key).is_some_and(|v| v.as_str().is_none()) {
                    report
                        .issue(
                            "provider-text",
                            "critical",
                            "供应商文字字段格式不正确",
                            CONFIG,
                            "接口地址与认证字段必须是文字；未回显字段值。",
                            solution,
                        )
                        .at(&["model_providers", id, key], Some(key));
                }
            }
            for key in ["requires_openai_auth", "supports_websockets"] {
                if table.get(key).is_some_and(|v| v.as_bool().is_none()) {
                    report
                        .issue(
                            "provider-boolean",
                            "critical",
                            "供应商开关格式不正确",
                            CONFIG,
                            "开关必须使用 true 或 false，不能使用带引号的文字。",
                            "将该开关写为 true 或 false（不带引号）。",
                        )
                        .at(&["model_providers", id, key], Some(key));
                }
            }
            if table
                .get("wire_api")
                .is_some_and(|v| v.as_str() != Some("responses"))
            {
                report
                    .issue(
                        "wire-api",
                        "critical",
                        "供应商协议不受支持",
                        CONFIG,
                        "当前 Codex 需要 responses 协议；其他上游协议请通过本地代理适配。",
                        "将 wire_api 设为 \"responses\"；其他协议请在线路编辑器中选择，由本地路由转换。",
                    )
                    .at(&["model_providers", id, "wire_api"], Some("wire_api"));
            }
            if let Some(url) = table.get("base_url").and_then(Item::as_str) {
                match url::Url::parse(url) {
                    Ok(parsed)
                        if matches!(parsed.scheme(), "http" | "https")
                            && parsed.host_str().is_some() =>
                    {
                        if parsed
                            .host_str()
                            .is_some_and(|h| h.eq_ignore_ascii_case("api.deepseek.com"))
                            && table.get("supports_websockets").and_then(Item::as_bool)
                                == Some(true)
                        {
                            report
                                .issue(
                                    "deepseek-ws",
                                    "warning",
                                    "DeepSeek WebSocket 设置需检查",
                                    CONFIG,
                                    "DeepSeek 官方接口应使用 HTTP 连接。",
                                    "删除 supports_websockets 这一行，或把它设为 false。",
                                )
                                .at(
                                    &["model_providers", id, "supports_websockets"],
                                    Some("supports_websockets"),
                                );
                        }
                    }
                    _ => {
                        report
                            .issue(
                                "provider-url",
                                "critical",
                                "供应商接口地址无效",
                                CONFIG,
                                "接口地址需要有效的 HTTP 或 HTTPS URL；未回显地址。",
                                "填写以 http:// 或 https:// 开头的完整接口地址。",
                            )
                            .at(&["model_providers", id, "base_url"], Some("base_url"));
                    }
                }
            }
        }
    }
    check_file_refs(root, &[], base, report);
    if let Some(item) = root.get("profiles") {
        if let Some(profiles) = item.as_table_like() {
            for (name, item) in profiles.iter() {
                let Some(profile) = item.as_table_like() else {
                    report
                        .issue(
                            "profile-type",
                            "critical",
                            "配置档格式不正确",
                            CONFIG,
                            "每个配置档必须是配置表。",
                            "把这一项改成 [profiles.名称] 表，或删除它。",
                        )
                        .at(&["profiles", name], None);
                    continue;
                };
                check_file_refs(profile, &["profiles", name], base, report);
                if profile
                    .get("model")
                    .is_some_and(|value| value.as_str().is_none_or(|model| model.trim().is_empty()))
                {
                    report
                        .issue(
                            "profile-selector-type",
                            "critical",
                            "配置档模型选择格式不正确",
                            CONFIG,
                            "配置档的模型必须是非空文字。",
                            "把 model 写成带引号的模型名称，或删除这一行。",
                        )
                        .at(&["profiles", name, "model"], Some("model"));
                }
                if let Some(item) = profile.get("model_provider") {
                    match item.as_str() {
                        Some(id) if !id.trim().is_empty() => {
                            if !BUILTIN_PROVIDERS.contains(&id)
                                && !providers.is_some_and(|p| p.contains_key(id))
                            {
                                report
                                    .issue(
                                        "profile-provider-missing",
                                        "critical",
                                        "配置档选用的供应商不存在",
                                        CONFIG,
                                        "请检查配置档内的 model_provider 与供应商定义。",
                                        "改成已定义的供应商，或补上与它同名的 [model_providers] 表。",
                                    )
                                    .at(
                                        &["profiles", name, "model_provider"],
                                        Some("model_provider"),
                                    );
                            }
                        }
                        _ => {
                            report
                                .issue(
                                    "profile-selector-type",
                                    "critical",
                                    "配置档供应商选择格式不正确",
                                    CONFIG,
                                    "供应商选择器必须是非空文字。",
                                    "把 model_provider 写成带引号的供应商名称，或删除这一行。",
                                )
                                .at(
                                    &["profiles", name, "model_provider"],
                                    Some("model_provider"),
                                );
                        }
                    }
                }
            }
        } else {
            report
                .issue(
                    "profiles-type",
                    "critical",
                    "配置档集合格式不正确",
                    CONFIG,
                    "profiles 必须是配置表。",
                    "用 [profiles.名称] 表头分别写每个配置档，不要直接给 profiles 赋值。",
                )
                .at(&["profiles"], Some("profiles"));
        }
    }
    check_legacy_tui_prompt(root, report);
}

fn check_file_refs(table: &dyn TableLike, prefix: &[&str], base: &Path, report: &mut HealthReport) {
    for key in ["model_instructions_file", "model_catalog_json"] {
        let Some(item) = table.get(key) else { continue };
        let anchor = [prefix, &[key][..]].concat();
        let Some(value) = item.as_str().filter(|s| !s.trim().is_empty()) else {
            report
                .issue(
                    "file-ref-type",
                    "critical",
                    "外部文件引用无效",
                    CONFIG,
                    "指令或模型目录引用必须是非空路径。",
                    "填写带引号的文件路径；不需要时删除这一行。",
                )
                .at(&anchor, Some(key));
            continue;
        };
        let path = Path::new(value);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            base.join(path)
        };
        let instructions = key == "model_instructions_file";
        match read_limited(&path, MAX_CONFIG_FILE_BYTES) {
            Ok(bytes) if instructions => {
                if std::str::from_utf8(&bytes).map_or(true, |text| text.trim().is_empty()) {
                    let issue = report.issue(
                        "instructions-empty",
                        "critical",
                        "指令文件为空或编码无效",
                        CONFIG,
                        "Codex 可能拒绝启动；不会自动改动用户外部文件。",
                        "在指令文件中写入内容并保存为 UTF-8，或删除这一行引用。",
                    );
                    issue.at(&anchor, Some(key));
                    issue.repair_candidate = bytes.is_empty();
                }
            }
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Err(_) => {
                    report
                        .issue(
                            "catalog-json",
                            "critical",
                            "模型目录 JSON 无效",
                            CONFIG,
                            "模型目录文件不是有效的 JSON；未回显文件内容。",
                            "在「线路」页重新应用当前线路以重新生成模型目录，或删除这一行。",
                        )
                        .at(&anchor, Some(key));
                }
                Ok(value)
                    if value
                        .get("models")
                        .and_then(serde_json::Value::as_array)
                        .is_none() =>
                {
                    report
                        .issue(
                            "catalog-shape",
                            "critical",
                            "模型目录结构无效",
                            CONFIG,
                            "模型目录必须是包含 models 数组的 JSON 对象。",
                            "在「线路」页重新应用当前线路以重新生成模型目录，或删除这一行。",
                        )
                        .at(&anchor, Some(key));
                }
                Ok(_) => {}
            },
            Err(error) => {
                let failure = file_ref_failure(&error, instructions);
                let issue = report.issue(
                    failure.code,
                    failure.severity,
                    failure.title,
                    CONFIG,
                    failure.impact,
                    failure.solution,
                );
                issue.at(&anchor, Some(key));
                issue.repair_candidate = instructions && error.kind() == ErrorKind::NotFound;
            }
        }
    }
}

struct RefFailure {
    code: &'static str,
    severity: &'static str,
    title: &'static str,
    impact: &'static str,
    solution: &'static str,
}

/// Codex itself follows links and has no size limit, so those two cases are
/// only "not checked here", not faults.
fn file_ref_failure(error: &std::io::Error, instructions: bool) -> RefFailure {
    match limit_error(error) {
        Some(ResourceLimitError::Symlink) => RefFailure {
            code: "file-ref-linked",
            severity: "warning",
            title: "引用的文件是链接，未检查",
            impact: "Chimera++ 不跟随链接读取，因此没有检查这个文件；Codex 仍会读取它。",
            solution: "如需检查，请改为引用链接指向的原文件。",
        },
        Some(ResourceLimitError::TooLarge { .. }) => RefFailure {
            code: "file-ref-too-large",
            severity: "warning",
            title: "引用的文件过大，未检查",
            impact: "文件超过 8 MiB，Chimera++ 没有读取。",
            solution: "确认引用的是正确的文件；指令文件和模型目录通常只有几 KB。",
        },
        None if error.kind() == ErrorKind::NotFound => RefFailure {
            code: "file-ref-missing",
            severity: "critical",
            title: "引用的文件不存在",
            impact: if instructions {
                "Codex 找不到指令文件时会拒绝启动。"
            } else {
                "Codex 无法加载模型目录。"
            },
            solution: if instructions {
                "确认路径是否正确；不再需要时删除这一行。Chimera++ 自有的失效引用可用「修复自有引用」清理。"
            } else {
                "在「线路」页重新应用当前线路以重新生成模型目录，或删除这一行。"
            },
        },
        None if error.kind() == ErrorKind::PermissionDenied => RefFailure {
            code: "file-ref-permission",
            severity: "critical",
            title: "无权读取引用的文件",
            impact: "当前用户无法读取这个文件，Codex 也可能无法读取。",
            solution: "为当前用户授予读取权限后重新检查。",
        },
        None => RefFailure {
            code: "file-ref-unreadable",
            severity: "critical",
            title: "引用文件缺失或无法安全读取",
            impact: "这个路径不是可读取的普通文件；不会自动删除引用。",
            solution: "确认路径指向一个文件而不是文件夹；不需要时删除这一行。",
        },
    }
}

/// Detection only (PR6). Older Codex-X builds appended prompt paths after a
/// `[tui]` header. Codex reads `tui.model_availability_nux` as a table of
/// counters (codex-rs rust-v0.157.0 config/src/types.rs,
/// `ModelAvailabilityNuxConfig`), so text there rejects the whole file; a
/// path directly under `[tui]` is ignored.
fn check_legacy_tui_prompt(root: &Table, report: &mut HealthReport) {
    let Some(tui) = root.get("tui").and_then(Item::as_table_like) else {
        return;
    };
    if let Some(nux) = tui.get("model_availability_nux") {
        match nux.as_table_like() {
            None => {
                report
                    .issue(
                        "tui-nux-type",
                        "critical",
                        "旧版提示词设置使 Codex 拒绝加载配置",
                        CONFIG,
                        "[tui] 下的 model_availability_nux 只能是计数表，写成文字或路径会让 Codex 拒绝整份配置。",
                        "删除这一行；需要指令文件时，在 config.toml 顶部设置 model_instructions_file。",
                    )
                    .at(
                        &["tui", "model_availability_nux"],
                        Some("model_availability_nux"),
                    );
            }
            Some(counters) if counters.contains_key("model_instructions_file") => {
                report
                    .issue(
                        "tui-nux-prompt",
                        "critical",
                        "旧版提示词设置使 Codex 拒绝加载配置",
                        CONFIG,
                        "[tui.model_availability_nux] 只能记录数字，这里的 model_instructions_file 会让 Codex 拒绝整份配置。",
                        "删除这一行；需要指令文件时，在 config.toml 顶部设置 model_instructions_file。",
                    )
                    .at(
                        &["tui", "model_availability_nux", "model_instructions_file"],
                        Some("model_instructions_file"),
                    );
            }
            Some(_) => {}
        }
    }
    if tui.contains_key("model_instructions_file") {
        report
            .issue(
                "tui-prompt",
                "warning",
                "旧版提示词设置不会生效",
                CONFIG,
                "Codex 只在顶层读取 model_instructions_file，写在 [tui] 下会被忽略。",
                "把这一行移到 config.toml 顶部（任何 [表头] 之前），或删除它。",
            )
            .at(
                &["tui", "model_instructions_file"],
                Some("model_instructions_file"),
            );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[serial_test::serial]
    fn owned_repair_requires_fresh_confirmation_and_preserves_unrelated_values() {
        use crate::{database::Database, services::live_backup, store::AppState};
        let _home = live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let state = AppState::new(std::sync::Arc::new(Database::memory().unwrap()));
        let config = crate::codex_config::get_codex_config_path();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let original =
            "model = 'test'\nmodel_instructions_file = 'chimera/instructions/missing.md'\n";
        std::fs::write(&config, original).unwrap();
        let token = check().repair_token.unwrap();
        let changed = format!("{original}# external edit\n");
        std::fs::write(&config, &changed).unwrap();
        assert!(repair_owned_instruction_refs(&state, &token).is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), changed);
        assert!(
            live_backup::list_backups(&crate::app_config::AppType::Codex)
                .unwrap()
                .is_empty()
        );
        let fresh = check().repair_token.unwrap();
        let report = repair_owned_instruction_refs(&state, &fresh).unwrap();
        assert!(report.repair_token.is_none());
        let actual = std::fs::read_to_string(&config).unwrap();
        assert!(actual.contains("model = 'test'"));
        assert!(actual.contains("# external edit"));
        assert!(!actual.contains("model_instructions_file"));
        let backups = live_backup::list_backups(&crate::app_config::AppType::Codex).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].reason, live_backup::LiveBackupReason::PreRepair);
        assert_eq!(backups[0].files.len(), 1);
        assert!(repair_owned_instruction_refs(&state, &fresh).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn takeover_blocks_repair_before_any_backup_or_write() {
        use crate::{database::Database, services::live_backup, store::AppState};
        let _home = live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let state = AppState::new(std::sync::Arc::new(Database::memory().unwrap()));
        let config = crate::codex_config::get_codex_config_path();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let original = "model_instructions_file = 'chimera/instructions/missing.md'\n";
        std::fs::write(&config, original).unwrap();
        let token = check().repair_token.unwrap();
        futures::executor::block_on(state.db.save_live_backup("codex", "{}")).unwrap();
        assert!(repair_owned_instruction_refs(&state, &token).is_err());
        assert_eq!(std::fs::read_to_string(config).unwrap(), original);
        assert!(
            live_backup::list_backups(&crate::app_config::AppType::Codex)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    #[serial_test::serial]
    fn external_references_are_not_repair_candidates() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        assert!(repair_preview("model_instructions_file = 'external-missing.md'").is_err());
        assert!(repair_preview("model = 'test'").unwrap().is_none());
        assert!(repair_preview("[invalid").is_err());
    }

    #[test]
    #[serial_test::serial]
    fn observed_config_plan_rejects_a_later_external_write() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let config = crate::codex_config::get_codex_config_path();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let text = "model = 'test'\nmodel_instructions_file = 'chimera/instructions/missing.md'\n";
        std::fs::write(&config, text).unwrap();
        let snapshot = crate::config::cas::FileSnapshot::read(&config).unwrap();
        let (_, next) = repair_preview(text).unwrap().unwrap();
        let plan = crate::codex_live_write::plan_observed_config(snapshot, &next).unwrap();
        std::fs::write(&config, "model = 'external'\n").unwrap();
        assert!(plan.commit().is_err());
        assert_eq!(
            std::fs::read_to_string(config).unwrap(),
            "model = 'external'\n"
        );
    }

    #[test]
    fn diagnostics_never_write_or_return_secret_source() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        let text = "secret = 'private-token'\n[broken";
        std::fs::write(&config, text).unwrap();
        std::fs::write(&auth, "{private-auth-token").unwrap();
        let report = check_paths(&config, &auth);
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("private-token"));
        assert!(!serialized.contains("private-auth-token"));
        assert_eq!(std::fs::read_to_string(config).unwrap(), text);
        assert_eq!(report.issues.len(), 2);
    }
    #[test]
    fn reports_provider_and_reference_failures_without_values() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&config, "model_provider = 'missing-secret'\nmodel_instructions_file = 'absent.md'\n[model_providers.custom]\nname = 'Custom'\nrequires_openai_auth = 'true'\nwire_api = 'chat'\n").unwrap();
        let report = check_paths(&config, &auth);
        assert_eq!(report.issues.len(), 4);
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("missing-secret"));
        assert!(report.issues.iter().all(|i| !i.repairable));
    }
    #[test]
    fn checks_profile_references_without_exposing_profile_names() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&config, "[profiles.private_profile]\nmodel_provider = 'missing'\nmodel_instructions_file = 'absent.md'\n").unwrap();
        let report = check_paths(&config, &auth);
        assert_eq!(report.issues.len(), 2);
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("private_profile"));
    }

    #[test]
    fn reports_invalid_catalog_containers_without_exposing_contents() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        let catalog = dir.path().join("catalog.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&config, "model_catalog_json = 'catalog.json'").unwrap();
        for text in ["[]", "{}", "null", r#"{"models":"private-token"}"#] {
            std::fs::write(&catalog, text).unwrap();
            let report = check_paths(&config, &auth);
            assert!(report
                .issues
                .iter()
                .any(|issue| issue.id.starts_with("catalog-shape-")));
            assert!(!serde_json::to_string(&report)
                .unwrap()
                .contains("private-token"));
            assert_eq!(std::fs::read_to_string(&catalog).unwrap(), text);
        }
        std::fs::write(&catalog, r#"{"models":[]}"#).unwrap();
        assert!(check_paths(&config, &auth).issues.is_empty());
    }

    #[test]
    fn reports_invalid_profile_models_without_exposing_profile_names() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        for value in ["42", "true", "''", "'  '"] {
            std::fs::write(
                &config,
                format!("[profiles.private_profile]\nmodel = {value}\n"),
            )
            .unwrap();
            let report = check_paths(&config, &auth);
            assert!(report
                .issues
                .iter()
                .any(|issue| issue.id.starts_with("profile-selector-type-")));
            assert!(!serde_json::to_string(&report)
                .unwrap()
                .contains("private_profile"));
        }
        std::fs::write(&config, "[profiles.work]\nmodel = 'test-model'\n").unwrap();
        assert!(check_paths(&config, &auth).issues.is_empty());
    }

    #[test]
    fn accepts_builtin_provider_without_custom_definition() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&config, "model_provider = 'openai'").unwrap();
        assert!(check_paths(&config, &auth).issues.is_empty());
    }

    fn checked(text: &str) -> (HealthReport, String) {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&config, text).unwrap();
        let report = check_paths(&config, &auth);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
        let serialized = serde_json::to_string(&report).unwrap();
        (report, serialized)
    }

    fn with_field<'a>(report: &'a HealthReport, field: &str) -> &'a HealthIssue {
        report
            .issues
            .iter()
            .find(|issue| issue.field == Some(field))
            .unwrap()
    }

    #[test]
    fn locates_parameters_without_echoing_table_names() {
        let (report, serialized) =
            checked("[model_providers.private_id]\nsupports_websockets='TRUE'\n");
        let issue = with_field(&report, "supports_websockets");
        assert!(issue.id.starts_with("provider-boolean-"));
        assert_eq!((issue.line, issue.column), (Some(2), Some(1)));
        assert!(serialized.contains("\"field\":\"supports_websockets\""));
        // A missing parameter points at the table that lacks it.
        let name = with_field(&report, "name");
        assert_eq!((name.line, name.column), (Some(1), Some(18)));
        assert!(!serialized.contains("private_id"));
        assert!(!serialized.contains("TRUE"));
        assert!(!serialized.contains("anchor"));
    }

    #[test]
    fn locations_count_unicode_characters_and_skip_file_level_issues() {
        // wire_api follows CJK text on its line: column 25, not byte column 37.
        let (report, serialized) = checked(
            "# 中文注释\n[model_providers]\n\"中转站甲\" = { name = \"中文\", wire_api = \"chat\" }\n",
        );
        let issue = with_field(&report, "wire_api");
        assert_eq!((issue.line, issue.column), (Some(3), Some(25)));
        assert!(!serialized.contains("中转站甲"));
        let dir = tempfile::tempdir().unwrap();
        let missing = check_paths(
            &dir.path().join("config.toml"),
            &dir.path().join("auth.json"),
        );
        assert!(missing
            .issues
            .iter()
            .all(|issue| issue.line.is_none() && issue.field.is_none()));
    }

    #[test]
    fn syntax_errors_report_character_columns_and_categorized_advice() {
        // The error sits after a quoted CJK key: the column counts characters.
        let (report, _) = checked("# 中文注释\n\"中文\" = 中\n");
        let issue = &report.issues[0];
        assert!(issue.id.starts_with("toml-"));
        assert_eq!((issue.line, issue.column), (Some(2), Some(8)));
        assert!(issue.solution.contains("引号"));
        assert!(issue.field.is_none());

        let (report, serialized) = checked("secret = 'private-token\nnext = 1\n");
        assert!(report.issues[0].solution.contains("引号"));
        assert!(!serialized.contains("private-token"));
        assert!(!serialized.contains("secret"));

        let (report, _) = checked("model_instructions_file = \"C:\\Users\\lin\\rules.md\"\n");
        assert!(report.issues[0].solution.contains("单引号"));

        let (report, _) = checked("[model_providers.private_id\nname = 'x'\n");
        assert!(report.issues[0].solution.contains("表头"));
        assert_eq!(report.issues[0].line, Some(1));
    }

    #[test]
    fn every_issue_carries_its_own_suggestion() {
        let (report, _) = checked(
            "model_provider = 'missing-secret'\n[model_providers.custom]\nname = 'Custom'\nrequires_openai_auth = 'true'\nwire_api = 'chat'\nbase_url = 'not a url'\n",
        );
        let solution = |field: &str| with_field(&report, field).solution;
        assert!(solution("requires_openai_auth").contains("true 或 false"));
        assert!(solution("wire_api").contains("responses"));
        assert!(solution("model_provider").contains("线路"));
        assert!(solution("base_url").contains("https://"));
        assert_eq!(with_field(&report, "model_provider").line, Some(1));
        assert!(report
            .issues
            .iter()
            .all(|issue| issue.solution != "请检查配置；自动修复尚未开放。"));
    }

    #[test]
    fn root_profile_is_reported_because_codex_rejects_it() {
        let (report, serialized) =
            checked("profile = 'private_profile'\n[profiles.private_profile]\nmodel = 'x'\n");
        let issue = with_field(&report, "profile");
        assert!(issue.id.starts_with("profile-legacy-"));
        assert_eq!(issue.line, Some(1));
        assert!(!serialized.contains("private_profile"));
    }

    #[test]
    fn legacy_tui_prompt_keys_are_detected_without_changes() {
        let (report, _) = checked(
            "[tui]\nmodel_instructions_file = 'old.md'\n[tui.model_availability_nux]\nmodel_instructions_file = 'old.md'\n",
        );
        let ignored = report
            .issues
            .iter()
            .find(|issue| issue.id.starts_with("tui-prompt-"))
            .unwrap();
        assert_eq!((ignored.severity, ignored.line), ("warning", Some(2)));
        let rejected = report
            .issues
            .iter()
            .find(|issue| issue.id.starts_with("tui-nux-prompt-"))
            .unwrap();
        assert_eq!((rejected.severity, rejected.line), ("critical", Some(4)));
        let (report, _) = checked("[tui]\nmodel_availability_nux = 'old.md'\n");
        assert!(report.issues[0].id.starts_with("tui-nux-type-"));
        assert_eq!(report.issues[0].field, Some("model_availability_nux"));
        let (report, _) = checked("[tui.model_availability_nux]\n\"gpt-5\" = 2\n");
        assert!(report.issues.is_empty());
    }

    #[test]
    fn unreadable_files_explain_the_cause() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let auth = dir.path().join("auth.json");
        std::fs::File::create(&config)
            .unwrap()
            .set_len(MAX_CONFIG_FILE_BYTES + 1)
            .unwrap();
        std::fs::create_dir(&auth).unwrap();
        let report = check_paths(&config, &auth);
        assert!(report.issues[0].id.starts_with("too-large-"));
        assert!(report.issues[1].id.starts_with("auth-not-file-"));
        assert!(report.issues.iter().all(|issue| issue.line.is_none()));
        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir(&config).unwrap();
        assert!(check_paths(&config, &auth).issues[0]
            .id
            .starts_with("not-file-"));
    }

    #[cfg(unix)]
    #[test]
    fn linked_config_is_explained_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("dotfiles.toml");
        let config = dir.path().join("config.toml");
        std::fs::write(&target, "model = 'private-model'\n").unwrap();
        std::os::unix::fs::symlink(&target, &config).unwrap();
        let report = check_paths(&config, &dir.path().join("auth.json"));
        assert!(report.issues[0].id.starts_with("linked-"));
        assert!(report.issues[0].solution.contains("原文件"));
        assert!(std::fs::symlink_metadata(&config)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("private-model"));
    }

    #[test]
    #[serial_test::serial]
    fn only_owned_dangling_references_are_marked_repairable() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let config = crate::codex_config::get_codex_config_path();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            "model_instructions_file = 'chimera/instructions/missing.md'\n",
        )
        .unwrap();
        let report = check();
        assert!(report.repair_token.is_some());
        let issue = with_field(&report, "model_instructions_file");
        assert!(issue.id.starts_with("file-ref-missing-"));
        assert!(issue.repairable);
        assert_eq!(issue.line, Some(1));
        std::fs::write(&config, "model_instructions_file = 'external-missing.md'\n").unwrap();
        let report = check();
        assert!(report.repair_token.is_none());
        assert!(report.issues.iter().all(|issue| !issue.repairable));
    }
}
