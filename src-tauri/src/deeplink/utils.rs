//! Deep link utility functions
//!
//! Common helpers for URL validation, Base64 decoding, etc.

use crate::error::AppError;
use base64::prelude::*;
use url::Url;

/// Why a link with `configUrl` is refused (parser) or cannot be merged.
pub(super) const REMOTE_CONFIG_UNSUPPORTED: &str =
    "链接使用了远程配置（configUrl），Chimera++ 不支持从网络下载配置。请让链接提供方改用内嵌配置（config）。";

/// Validate that a string is a safe HTTP(S) URL.
///
/// Deep links are untrusted input. In addition to the scheme, require a host,
/// reject userinfo and fragments, and cap the length before handing the URL to
/// config writers or HTTP clients. The messages name the field, never the
/// value: the confirm dialog shows them, and a URL can carry a token.
pub fn validate_url(url_str: &str, field_name: &str) -> Result<(), AppError> {
    const MAX_URL_BYTES: usize = 4096;

    if url_str.len() > MAX_URL_BYTES {
        return Err(AppError::InvalidInput(format!(
            "链接中的“{field_name}”地址过长（最多 {MAX_URL_BYTES} 字节）。"
        )));
    }

    let url = Url::parse(url_str)
        .map_err(|_| AppError::InvalidInput(format!("链接中的“{field_name}”不是有效的网址。")))?;

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::InvalidInput(format!(
            "链接中的“{field_name}”必须是 http 或 https 地址。"
        )));
    }
    if url.host_str().is_none() {
        return Err(AppError::InvalidInput(format!(
            "链接中的“{field_name}”缺少主机名。"
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::InvalidInput(format!(
            "链接中的“{field_name}”不能包含用户名或密码。"
        )));
    }
    if url.fragment().is_some() {
        return Err(AppError::InvalidInput(format!(
            "链接中的“{field_name}”不能包含“#”片段。"
        )));
    }

    Ok(())
}

/// Decode a Base64 parameter from deep link URL
///
/// This function handles common issues with Base64 in URLs:
/// - `+` being decoded as space
/// - Missing padding `=`
/// - Both standard and URL-safe Base64 variants
pub fn decode_base64_param(field: &str, raw: &str) -> Result<Vec<u8>, AppError> {
    const MAX_BASE64_INPUT_BYTES: usize = 8 * 1024 * 1024;
    const MAX_DECODED_BYTES: usize = crate::security_limits::MAX_IMPORT_BYTES as usize;

    if raw.len() > MAX_BASE64_INPUT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "{field} 参数过大（Base64 输入最多 {MAX_BASE64_INPUT_BYTES} 字节）"
        )));
    }

    let mut candidates: Vec<String> = Vec::new();
    // Keep spaces (to restore `+`), but remove newlines
    let trimmed = raw.trim_matches(|c| c == '\r' || c == '\n');

    // First try restoring spaces to "+"
    if trimmed.contains(' ') {
        let replaced = trimmed.replace(' ', "+");
        if !replaced.is_empty() && !candidates.contains(&replaced) {
            candidates.push(replaced);
        }
    }

    // Original value
    if !trimmed.is_empty() && !candidates.contains(&trimmed.to_string()) {
        candidates.push(trimmed.to_string());
    }

    // Add padding variants
    let existing = candidates.clone();
    for candidate in existing {
        let mut padded = candidate.clone();
        let remainder = padded.len() % 4;
        if remainder != 0 {
            padded.extend(std::iter::repeat_n('=', 4 - remainder));
        }
        if !candidates.contains(&padded) {
            candidates.push(padded);
        }
    }

    let mut last_error: Option<String> = None;
    for candidate in candidates {
        for engine in [
            &BASE64_STANDARD,
            &BASE64_STANDARD_NO_PAD,
            &BASE64_URL_SAFE,
            &BASE64_URL_SAFE_NO_PAD,
        ] {
            match engine.decode(&candidate) {
                Ok(bytes) if bytes.len() <= MAX_DECODED_BYTES => return Ok(bytes),
                Ok(_) => {
                    return Err(AppError::InvalidInput(format!(
                        "{field} 参数解码后过大（最多 {MAX_DECODED_BYTES} 字节）"
                    )));
                }
                Err(err) => last_error = Some(err.to_string()),
            }
        }
    }

    Err(AppError::InvalidInput(format!(
        "{field} 参数 Base64 解码失败：{}。请确认链接参数已用 Base64 编码并经过 URL 转义（尤其是将 '+' 编码为 %2B，或使用 URL-safe Base64）。",
        last_error.unwrap_or_else(|| "未知错误".to_string())
    )))
}

/// Infer homepage URL from API endpoint
///
/// Examples:
/// - https://api.anthropic.com/v1 → https://anthropic.com
/// - https://api.openai.com/v1 → https://openai.com
/// - https://api-test.company.com/v1 → https://company.com
pub fn infer_homepage_from_endpoint(endpoint: &str) -> Option<String> {
    let url = Url::parse(endpoint).ok()?;
    let host = url.host_str()?;

    // Remove common API prefixes
    let clean_host = host
        .strip_prefix("api.")
        .or_else(|| host.strip_prefix("api-"))
        .unwrap_or(host);

    Some(format!("https://{clean_host}"))
}
