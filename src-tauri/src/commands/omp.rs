//! OMP native model configuration. Never touches Pi or auth credentials files.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const LIMIT: u64 = 1024 * 1024;

/// Prefix of the error a save returns when the file holds YAML that a
/// rewrite through serde_yaml cannot keep (comments, anchors, aliases, tags,
/// merge keys). The UI asks the user, then saves again with
/// `allow_lossy_rewrite`.
pub(crate) const OMP_LOSSY_REWRITE_CODE: &str = "OMP_LOSSY_REWRITE";

/// Whether `text` uses YAML that the parse-and-serialize save would drop or
/// expand. A light line scan, not a parser: `#` only counts after whitespace
/// or at the line start, `&` `*` `!` `<<` only where a node can start (line
/// start, after `: `, `- `, `[`, `{`, `,`), and quoted text is skipped, so a
/// plain value such as `Search & Fetch` or `http://x/#a` is not flagged. It
/// may flag a `#` inside a block scalar; that only asks the user once more.
// Adapted from farion1231/cc-switch e332cfdb
fn yaml_has_lossy_constructs(text: &str) -> bool {
    text.lines().any(line_has_lossy_construct)
}

fn line_has_lossy_construct(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let mut quote: Option<char> = None;
    let mut node_start = true;
    let mut previous: Option<char> = None;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let next = chars.get(index + 1).copied();
        if let Some(open) = quote {
            if open == '"' && c == '\\' {
                index += 2;
                continue;
            }
            if c == open {
                quote = None;
            }
            previous = Some(c);
            index += 1;
            continue;
        }
        let next_is_space = next.is_none_or(char::is_whitespace);
        match c {
            '#' if previous.is_none_or(char::is_whitespace) => return true,
            '"' | '\'' if node_start => quote = Some(c),
            '&' | '*' | '!' if node_start && !next_is_space => return true,
            '<' if node_start && next == Some('<') => {
                let rest: String = chars[index + 2..].iter().collect();
                if rest.trim_start().starts_with(':') {
                    return true;
                }
            }
            _ => {}
        }
        node_start = match c {
            ' ' | '\t' => node_start,
            ':' | '-' => next_is_space,
            '[' | '{' | ',' => true,
            _ => false,
        };
        previous = Some(c);
        index += 1;
    }
    false
}

/// Copy the file about to be rewritten next to it as
/// `<name>.bak-<timestamp>` (permissions kept by `fs::copy`).
fn backup_before_lossy_rewrite(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("models.yml");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut backup = path.with_file_name(format!("{name}.bak-{stamp}"));
    let mut attempt = 1;
    while exists(&backup)? {
        attempt += 1;
        backup = path.with_file_name(format!("{name}.bak-{stamp}-{attempt}"));
    }
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
        return Err("OMP 配置不是普通文件，保存已取消".into());
    }
    fs::copy(path, &backup).map_err(|_| "无法备份 OMP 配置，保存已取消；草稿已保留")?;
    Ok(backup)
}

fn profile(value: &str) -> Result<Option<&str>, String> {
    let value = value.trim();
    if value.is_empty() || value == "default" {
        return Ok(None);
    }
    let valid = regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").unwrap();
    let reserved = regex::Regex::new(r"(?i)^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)").unwrap();
    if !valid.is_match(value) || value.ends_with('.') || reserved.is_match(value) {
        return Err("OMP profile 名称无效".into());
    }
    Ok(Some(value))
}

fn agent_dir() -> Result<PathBuf, String> {
    let home = crate::config::get_home_dir();
    let root_name = std::env::var("PI_CONFIG_DIR").unwrap_or_default();
    let root_name = if root_name.is_empty() {
        ".omp"
    } else {
        &root_name
    };
    // Reject ambiguous overrides instead of writing somewhere the CLI may not read.
    if Path::new(root_name).is_absolute()
        || Path::new(root_name)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("PI_CONFIG_DIR 必须是 home 下的相对目录".into());
    }
    let root = home.join(root_name);
    let env_profile = std::env::var("OMP_PROFILE")
        .or_else(|_| std::env::var("PI_PROFILE"))
        .unwrap_or_default();
    if let Some(name) = profile(&env_profile)? {
        return Ok(root.join("profiles").join(name).join("agent"));
    }
    if let Some(override_dir) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|s| !s.is_empty()) {
        let path = PathBuf::from(override_dir);
        if !path.is_absolute() {
            return Err("PI_CODING_AGENT_DIR 必须是绝对路径".into());
        }
        let legacy_profile = std::env::var("PI_PROFILE").unwrap_or_default();
        let derived = profile(&legacy_profile)
            .ok()
            .flatten()
            .map(|name| root.join("profiles").join(name).join("agent"));
        if derived.as_ref() != Some(&path) {
            return Ok(path);
        }
    }
    Ok(root.join("agent"))
}

fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法检查 OMP 配置文件权限".into()),
    }
}

fn model_path(dir: &Path) -> Result<PathBuf, String> {
    for name in ["models.yml", "models.yaml"] {
        let path = dir.join(name);
        if exists(&path)? {
            return Ok(path);
        }
    }
    if exists(&dir.join("models.json"))? {
        return Err(
            "发现旧版 OMP models.json，请先启动 omp 完成原生 YAML 迁移后再刷新；未写入任何文件。"
                .into(),
        );
    }
    Ok(dir.join("models.yml"))
}

fn bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 OMP 配置文件".into()),
    };
    let mut data = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(|_| "读取 OMP 配置失败")?;
    if data.len() as u64 > LIMIT {
        return Err("OMP 配置不能超过 1 MiB".into());
    }
    Ok(Some(data))
}

fn revision(data: Option<&[u8]>) -> String {
    data.map(|b| format!("{:x}", Sha256::digest(b)))
        .unwrap_or_else(|| "missing".into())
}

fn read(dir: &Path) -> Result<crate::pi_config::PiDocument, String> {
    let path = model_path(dir)?;
    let data = bytes(&path)?;
    let value: Value = match data.as_ref() {
        // Do not expose parser snippets: they may contain API keys.
        Some(data) => serde_yaml::from_slice(data)
            .map_err(|_| "OMP YAML 无法解析，请检查原始文件（未显示内容以保护密钥）")?,
        None => json!({}),
    };
    if !value.is_object() || value.get("providers").is_some_and(|v| !v.is_object()) {
        return Err("OMP 配置及 providers 必须是对象".into());
    }
    Ok(crate::pi_config::PiDocument {
        value,
        revision: revision(data.as_deref()),
        path: path.display().to_string(),
    })
}

fn validate_provider(provider: &Value) -> Result<(), String> {
    let object = provider.as_object().ok_or("线路配置必须是对象")?;
    for key in ["baseUrl", "api", "apiKey", "auth"] {
        if object.get(key).is_some_and(|v| !v.is_string()) {
            return Err(format!("{key} 必须是文本"));
        }
    }
    if let Some(auth) = object.get("auth").and_then(Value::as_str) {
        if !["apiKey", "none", "oauth"].contains(&auth) {
            return Err("认证方式无效".into());
        }
    }
    if let Some(api) = object.get("api").and_then(Value::as_str) {
        if ![
            "openai-completions",
            "openai-responses",
            "openai-codex-responses",
            "azure-openai-responses",
            "anthropic-messages",
            "bedrock-converse-stream",
            "google-generative-ai",
            "google-gemini-cli",
            "google-vertex",
            "openrouter-decisions",
            "typesafe",
        ]
        .contains(&api)
        {
            return Err("不支持的 OMP API 协议".into());
        }
    }
    if let Some(base_url) = object.get("baseUrl").and_then(Value::as_str) {
        let url = url::Url::parse(base_url).map_err(|_| "API 地址格式无效")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("API 地址须为不含账号密码的 HTTP(S) 地址".into());
        }
    }
    if let Some(discovery) = object.get("discovery") {
        if object
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
            && discovery.get("type").and_then(Value::as_str) != Some("proxy")
        {
            return Err("模型发现需要 API 协议".into());
        }
    }
    let models = object
        .get("models")
        .map(|v| v.as_array().ok_or("models 必须是数组"))
        .transpose()?;
    if let Some(models) = models.filter(|models| !models.is_empty()) {
        if object
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err("包含自定义模型的线路必须填写 API 地址".into());
        }
        let auth = object
            .get("auth")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !["none", "oauth"].contains(&auth)
            && object
                .get("apiKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            return Err("请填写 API Key / 环境变量名，或使用免认证方式".into());
        }
        let mut ids = std::collections::HashSet::new();
        for model in models {
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or("每个模型必须有 ID")?;
            if !ids.insert(id) {
                return Err("模型 ID 重复".into());
            }
            if model
                .get("api")
                .or_else(|| object.get("api"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                return Err("请为线路或模型指定 API 协议".into());
            }
        }
    } else if ![
        "baseUrl",
        "headers",
        "compat",
        "apiKey",
        "disableStrictTools",
        "guardrailIdentifier",
        "requestMetadata",
        "remoteCompaction",
        "modelOverrides",
        "discovery",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
        && object.get("auth").and_then(Value::as_str) != Some("none")
    {
        return Err("线路至少需要地址、密钥或模型覆盖配置".into());
    }
    Ok(())
}

fn save(
    dir: &Path,
    value: Value,
    expected_revision: &str,
    expected_path: &str,
    allow_lossy_rewrite: bool,
) -> Result<crate::pi_config::PiDocument, String> {
    let current = read(dir)?;
    if current.revision != expected_revision || current.path != expected_path {
        return Err("OMP 配置已被外部修改，请保留草稿并重新读取后再保存".into());
    }
    let original = bytes(Path::new(&current.path))?;
    let lossy = original
        .as_deref()
        .is_some_and(|data| yaml_has_lossy_constructs(&String::from_utf8_lossy(data)));
    if lossy && !allow_lossy_rewrite {
        return Err(format!(
            "{OMP_LOSSY_REWRITE_CODE}: models.yml 含注释、锚点或别名，保存会重写整个文件：注释会丢失，锚点和别名会展开成重复内容。"
        ));
    }
    let providers = value
        .get("providers")
        .and_then(Value::as_object)
        .ok_or("providers 必须是对象")?;
    if !value.is_object() {
        return Err("OMP 配置必须是对象".into());
    }
    for (id, provider) in providers {
        if id.trim().is_empty() || id.chars().any(char::is_control) {
            return Err("线路 ID 无效".into());
        }
        if current.value.get("providers").and_then(|v| v.get(id)) != Some(provider) {
            validate_provider(provider)?;
        }
    }
    let data = serde_yaml::to_string(&value)
        .map_err(|_| "无法生成 OMP YAML")?
        .into_bytes();
    if data.len() as u64 > LIMIT {
        return Err("OMP 配置不能超过 1 MiB".into());
    }
    let path = PathBuf::from(&current.path);
    if lossy {
        let backup = backup_before_lossy_rewrite(&path)?;
        log::info!("[OMP] 重写前已备份 {}", backup.display());
    }
    crate::config::atomic_write_checked::<crate::error::AppError, _>(&path, &data, true, || {
        let latest_path = model_path(dir).map_err(crate::error::AppError::Config)?;
        let latest = bytes(&path).map_err(crate::error::AppError::Config)?;
        if latest_path != path || revision(latest.as_deref()) != expected_revision {
            return Err(crate::error::AppError::Config(
                "OMP 配置已被外部修改，保存已取消".into(),
            ));
        }
        Ok(())
    })
    .map_err(|_| "OMP 保存失败：文件已改变、为符号链接或不可写；草稿已保留")?;
    Ok(crate::pi_config::PiDocument {
        value,
        revision: revision(Some(&data)),
        path: current.path,
    })
}

#[tauri::command]
pub(crate) fn get_omp_models() -> Result<crate::pi_config::PiDocument, String> {
    crate::product_policy::require(crate::product_policy::Capability::MultiTool)?;
    let _operation = super::pi_plugins::lock_package_operation()?;
    read(&agent_dir()?)
}

#[tauri::command]
pub(crate) fn save_omp_models(
    value: Value,
    expected_revision: String,
    expected_path: String,
    allow_lossy_rewrite: Option<bool>,
) -> Result<crate::pi_config::PiDocument, String> {
    crate::product_policy::require(crate::product_policy::Capability::MultiTool)?;
    let _operation = super::pi_plugins::lock_package_operation()?;
    save(
        &agent_dir()?,
        value,
        &expected_revision,
        &expected_path,
        allow_lossy_rewrite.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_fields_and_rejects_stale_writes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("models.yaml"),
            "future: true\nproviders: {}\n",
        )
        .unwrap();
        let original = read(dir.path()).unwrap();
        let value = json!({"future":true,"providers":{"local":{"baseUrl":"http://localhost:1234/v1","auth":"none","api":"openai-completions","models":[{"id":"local"}]}}});
        let saved = save(
            dir.path(),
            value.clone(),
            &original.revision,
            &original.path,
            false,
        )
        .unwrap();
        assert!(saved.path.ends_with("models.yaml"));
        assert_eq!(saved.value["future"], true);
        assert_eq!(saved.revision, read(dir.path()).unwrap().revision);
        assert!(save(dir.path(), value, &original.revision, &original.path, false).is_err());
        fs::write(dir.path().join("models.yml"), "providers: {}\n").unwrap();
        assert!(save(dir.path(), saved.value, &saved.revision, &saved.path, false).is_err());
    }

    #[test]
    fn detects_comments_anchors_aliases_tags_and_merge_keys_only_where_yaml_has_them() {
        for lossy in [
            "# heading\nproviders: {}\n",
            "providers: {} # trailing\n",
            "base: &base\n  api: openai-completions\n",
            "providers:\n  a: *base\n",
            "providers:\n  a:\n    <<: *base\n",
            "providers:\n  - !custom x\n",
            "list: [a, &b c]\n",
        ] {
            assert!(yaml_has_lossy_constructs(lossy), "{lossy:?}");
        }
        for plain in [
            "providers:\n  a:\n    name: Search & Fetch\n",
            "url: http://example.com/#fragment\n",
            "color: \"#fff\"\n",
            "color: '#fff'\n",
            "note: it's * fine & good!\n",
            "key: \"a \\\" # still quoted\"\n",
            "providers: {}\n",
        ] {
            assert!(!yaml_has_lossy_constructs(plain), "{plain:?}");
        }
    }

    #[test]
    fn lossy_files_need_confirmation_and_are_backed_up_before_the_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.yml");
        let original_text = "# my notes\nproviders: {}\n";
        fs::write(&path, original_text).unwrap();
        let original = read(dir.path()).unwrap();
        let value = json!({"providers":{"local":{"baseUrl":"http://localhost:1234/v1","auth":"none","api":"openai-completions","models":[{"id":"local"}]}}});

        let error = save(
            dir.path(),
            value.clone(),
            &original.revision,
            &original.path,
            false,
        )
        .unwrap_err();
        assert!(error.starts_with(OMP_LOSSY_REWRITE_CODE), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original_text);

        let saved = save(dir.path(), value, &original.revision, &original.path, true).unwrap();
        assert!(saved.value["providers"]["local"].is_object());
        assert!(!fs::read_to_string(&path).unwrap().contains("my notes"));
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("models.yml.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(
            fs::read_to_string(dir.path().join(&backups[0])).unwrap(),
            original_text
        );
    }
    #[test]
    fn refuses_legacy_and_invalid_config() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("models.json"), "{}").unwrap();
        assert!(read(dir.path()).is_err());
        assert!(validate_provider(&json!({"models":[{"id":"x"}]})).is_err());
        assert!(validate_provider(&json!({"baseUrl":"https://user:secret@example.com"})).is_err());
        assert!(
            validate_provider(&json!({"baseUrl":"https://example.com", "api":"typo"})).is_err()
        );
        assert!(
            validate_provider(&json!({"baseUrl":"https://example.com", "auth":"invalid"})).is_err()
        );
        assert!(profile("../other").is_err());
        assert!(profile("con").is_err());
    }
}
