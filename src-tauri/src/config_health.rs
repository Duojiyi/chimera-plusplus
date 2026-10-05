//! Read-only Codex diagnostics and explicitly confirmed owned-reference repair.
//! Reports never expose raw config values.
//! Provider rules adapted from yynxxxxx/Codex-X (MIT),
//! apps/desktop/src-tauri/src/config_health.rs at
//! 8f018fddd3ee1a68464e4df8765eb370ede0c76f.
use crate::security_limits::{read_limited, MAX_CONFIG_FILE_BYTES};
use serde::Serialize;
use std::path::Path;
use toml_edit::{DocumentMut, Item, TableLike};

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
    ) {
        self.issues.push(HealthIssue {
            id: format!("{code}-{}", self.issues.len()),
            severity,
            title,
            location,
            impact: impact.into(),
            solution: "请检查配置；自动修复尚未开放。",
            repairable: false,
        });
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
            Ok(text) => match text.parse::<DocumentMut>() {
                Ok(doc) => {
                    analyze(&doc, config.parent().unwrap_or(Path::new(".")), &mut report);
                    if config == crate::codex_config::get_codex_config_path() {
                        if let Ok(Some((token, _))) = repair_preview(text) {
                            report.repair_token = Some(token);
                        }
                    }
                }
                Err(error) => {
                    // TOML errors may include complete source lines, including API keys.
                    let offset = error
                        .span()
                        .map(|span| span.start)
                        .unwrap_or(0)
                        .min(text.len());
                    let prefix = &text.as_bytes()[..offset];
                    let line = prefix.iter().filter(|&&b| b == b'\n').count() + 1;
                    let column = prefix.iter().rev().take_while(|&&b| b != b'\n').count() + 1;
                    report.issue(
                        "toml",
                        "critical",
                        "配置语法不正确",
                        "config.toml",
                        format!("请检查第 {line} 行、第 {column} 字节列；未回显配置内容。"),
                    );
                }
            },
            Err(_) => report.issue(
                "encoding",
                "critical",
                "配置编码不正确",
                "config.toml",
                "配置必须使用 UTF-8 编码。",
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => report.issue(
            "missing",
            "warning",
            "尚未创建 Codex 配置",
            "config.toml",
            "首次使用时可以通过线路页面配置。",
        ),
        Err(_) => report.issue(
            "unreadable",
            "critical",
            "无法安全读取配置",
            "config.toml",
            "请检查权限、文件大小及文件类型；不会读取符号链接。",
        ),
    }
    match read_limited(auth, MAX_CONFIG_FILE_BYTES) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => {}
            _ => report.issue(
                "auth-format",
                "critical",
                "登录配置格式不正确",
                "auth.json",
                "登录配置必须是 JSON 对象；未回显凭据内容。",
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => report.issue(
            "auth-missing",
            "warning",
            "未发现登录配置",
            "auth.json",
            "使用环境变量认证时可以没有此文件；官方账户可通过登录流程创建。",
        ),
        Err(_) => report.issue(
            "auth-unreadable",
            "critical",
            "无法安全读取登录配置",
            "auth.json",
            "请检查权限、文件大小及文件类型；未读取凭据。",
        ),
    }
    report
}

fn analyze(doc: &DocumentMut, base: &Path, report: &mut HealthReport) {
    let providers = doc.get("model_providers").and_then(Item::as_table_like);
    if doc.get("model_providers").is_some() && providers.is_none() {
        report.issue(
            "providers-type",
            "critical",
            "供应商集合格式不正确",
            "config.toml · model_providers",
            "供应商集合必须是配置表。",
        );
    }
    for key in ["model_provider", "model", "profile"] {
        if doc
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            report.issue(
                "selector-type",
                "critical",
                "模型或线路选择格式不正确",
                "config.toml · selectors",
                "模型、供应商与配置档选择器必须是非空文字。",
            );
        }
    }
    if let Some(selected) = doc.get("model_provider").and_then(Item::as_str) {
        let builtin = [
            "openai",
            "ollama",
            "lmstudio",
            "amazon-bedrock",
            "amazon-bedrock-runtime",
        ];
        if !builtin.contains(&selected) && !providers.is_some_and(|p| p.contains_key(selected)) {
            report.issue(
                "provider-missing",
                "critical",
                "选用的供应商缺少配置",
                "config.toml · model_provider",
                "当前供应商标识在配置中不存在，请重新选择线路。",
            );
        }
    }
    if let Some(selected) = doc.get("profile").and_then(Item::as_str) {
        if !doc
            .get("profiles")
            .and_then(Item::as_table_like)
            .is_some_and(|p| p.contains_key(selected))
        {
            report.issue(
                "profile-missing",
                "critical",
                "选用的配置档不存在",
                "config.toml · profile",
                "请检查配置档选择器与 profiles 定义。",
            );
        }
    }
    if let Some(providers) = providers {
        for (id, item) in providers.iter() {
            let Some(table) = item.as_table_like() else {
                report.issue(
                    "provider-type",
                    "critical",
                    "供应商配置格式不正确",
                    "config.toml · model_providers",
                    "有一条供应商配置不是配置表。",
                );
                continue;
            };
            if !matches!(id, "amazon-bedrock" | "amazon-bedrock-runtime")
                && table
                    .get("name")
                    .and_then(Item::as_str)
                    .is_none_or(|s| s.trim().is_empty())
            {
                report.issue(
                    "provider-name",
                    "critical",
                    "供应商缺少有效名称",
                    "config.toml · model_providers",
                    "供应商名称必须是非空文字。",
                );
            }
            for key in ["base_url", "env_key", "experimental_bearer_token"] {
                if table.get(key).is_some_and(|v| v.as_str().is_none()) {
                    report.issue(
                        "provider-text",
                        "critical",
                        "供应商文字字段格式不正确",
                        "config.toml · model_providers",
                        "接口地址与认证字段必须是文字；未回显字段值。",
                    );
                }
            }
            for key in ["requires_openai_auth", "supports_websockets"] {
                if table.get(key).is_some_and(|v| v.as_bool().is_none()) {
                    report.issue(
                        "provider-boolean",
                        "critical",
                        "供应商开关格式不正确",
                        "config.toml · model_providers",
                        "开关必须使用 true 或 false，不能使用带引号的文字。",
                    );
                }
            }
            if table
                .get("wire_api")
                .is_some_and(|v| v.as_str() != Some("responses"))
            {
                report.issue(
                    "wire-api",
                    "critical",
                    "供应商协议不受支持",
                    "config.toml · model_providers",
                    "当前 Codex 需要 responses 协议；其他上游协议请通过本地代理适配。",
                );
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
                            report.issue(
                                "deepseek-ws",
                                "warning",
                                "DeepSeek WebSocket 设置需检查",
                                "config.toml · model_providers",
                                "DeepSeek 官方接口应使用 HTTP 连接。",
                            );
                        }
                    }
                    _ => report.issue(
                        "provider-url",
                        "critical",
                        "供应商接口地址无效",
                        "config.toml · model_providers",
                        "接口地址需要有效的 HTTP 或 HTTPS URL；未回显地址。",
                    ),
                }
            }
        }
    }
    check_file_refs(doc.as_table(), base, report);
    if let Some(item) = doc.get("profiles") {
        if let Some(profiles) = item.as_table_like() {
            for (_, item) in profiles.iter() {
                let Some(profile) = item.as_table_like() else {
                    report.issue(
                        "profile-type",
                        "critical",
                        "配置档格式不正确",
                        "config.toml · profiles",
                        "每个配置档必须是配置表。",
                    );
                    continue;
                };
                check_file_refs(profile, base, report);
                if profile
                    .get("model")
                    .is_some_and(|value| value.as_str().is_none_or(|model| model.trim().is_empty()))
                {
                    report.issue(
                        "profile-selector-type",
                        "critical",
                        "配置档模型选择格式不正确",
                        "config.toml · profiles",
                        "配置档的模型必须是非空文字。",
                    );
                }
                if let Some(item) = profile.get("model_provider") {
                    match item.as_str() {
                        Some(id) if !id.trim().is_empty() => {
                            if ![
                                "openai",
                                "ollama",
                                "lmstudio",
                                "amazon-bedrock",
                                "amazon-bedrock-runtime",
                            ]
                            .contains(&id)
                                && !providers.is_some_and(|p| p.contains_key(id))
                            {
                                report.issue(
                                    "profile-provider-missing",
                                    "critical",
                                    "配置档选用的供应商不存在",
                                    "config.toml · profiles",
                                    "请检查配置档内的 model_provider 与供应商定义。",
                                );
                            }
                        }
                        _ => report.issue(
                            "profile-selector-type",
                            "critical",
                            "配置档供应商选择格式不正确",
                            "config.toml · profiles",
                            "供应商选择器必须是非空文字。",
                        ),
                    }
                }
            }
        } else {
            report.issue(
                "profiles-type",
                "critical",
                "配置档集合格式不正确",
                "config.toml · profiles",
                "profiles 必须是配置表。",
            );
        }
    }
}

fn check_file_refs(doc: &dyn TableLike, base: &Path, report: &mut HealthReport) {
    for key in ["model_instructions_file", "model_catalog_json"] {
        let Some(item) = doc.get(key) else { continue };
        let Some(value) = item.as_str().filter(|s| !s.trim().is_empty()) else {
            report.issue(
                "file-ref-type",
                "critical",
                "外部文件引用无效",
                "config.toml · file references",
                "指令或模型目录引用必须是非空路径。",
            );
            continue;
        };
        let path = Path::new(value);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            base.join(path)
        };
        match read_limited(&path, MAX_CONFIG_FILE_BYTES) {
            Ok(bytes) if key == "model_instructions_file" => {
                if std::str::from_utf8(&bytes).map_or(true, |text| text.trim().is_empty()) {
                    report.issue(
                        "instructions-empty",
                        "critical",
                        "指令文件为空或编码无效",
                        "config.toml · model_instructions_file",
                        "Codex 可能拒绝启动；不会自动改动用户外部文件。",
                    );
                }
            }
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Err(_) => report.issue(
                    "catalog-json",
                    "critical",
                    "模型目录 JSON 无效",
                    "config.toml · model_catalog_json",
                    "请重新生成模型目录文件；未回显文件内容。",
                ),
                Ok(value)
                    if value
                        .get("models")
                        .and_then(serde_json::Value::as_array)
                        .is_none() =>
                {
                    report.issue(
                        "catalog-shape",
                        "critical",
                        "模型目录结构无效",
                        "config.toml · model_catalog_json",
                        "模型目录必须是包含 models 数组的 JSON 对象；请重新生成模型目录文件。",
                    );
                }
                Ok(_) => {}
            },
            Err(_) => report.issue(
                "file-ref-unreadable",
                "critical",
                "引用文件缺失或无法安全读取",
                "config.toml · file references",
                "请检查指令与模型目录文件是否存在、权限与大小；不会自动删除引用。",
            ),
        }
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
}
