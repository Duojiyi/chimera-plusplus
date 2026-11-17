//! Validation shared by the CLI-backed browser login fallbacks.
//! Codes stay inside the active flow; arbitrary pasted URLs are never fetched.

use crate::error::AppError;
use url::Url;

/// Remove terminal decoration without changing the visible authorization URL.
pub(crate) fn plain_terminal_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn invalid(message: &str) -> AppError {
    AppError::Message(message.to_string())
}

fn parameter(url: &Url, name: &str) -> Result<String, AppError> {
    let mut values = url.query_pairs().filter(|(key, _)| key == name);
    let value = values.next().map(|(_, value)| value.into_owned());
    if values.next().is_some() {
        return Err(invalid("授权结果包含重复参数，请重新复制完整内容。"));
    }
    value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("授权结果不完整，请复制完整的回调地址或授权码。"))
}

fn input_text(input: &str) -> Result<&str, AppError> {
    let input = input.trim();
    if input.is_empty() || input.len() > 16 * 1024 || input.chars().any(char::is_control) {
        return Err(invalid("请粘贴完整的回调地址或授权码。"));
    }
    Ok(input)
}

fn checked_code(code: &str, state: &str, authorization: &Url) -> Result<(), AppError> {
    if state != parameter(authorization, "state")? {
        return Err(invalid(
            "这份授权结果不属于本次登录，请使用当前授权链接重新授权。",
        ));
    }
    if code.is_empty()
        || code.len() > 8192
        || code.contains(['#', '\r', '\n'])
        || code.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(invalid("授权码格式不正确，请重新复制完整内容。"));
    }
    Ok(())
}

/// Claude's CLI accepts the official code#state format on stdin.
pub(crate) fn manual_code(input: &str, authorization: &str) -> Result<String, AppError> {
    let input = input_text(input)?;
    let authorization =
        Url::parse(authorization).map_err(|_| invalid("当前授权链接不可用，请重新开始。"))?;
    let (code, state) = if let Ok(url) = Url::parse(input) {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid("请粘贴浏览器返回的完整回调地址。"));
        }
        (parameter(&url, "code")?, parameter(&url, "state")?)
    } else {
        let (code, state) = input
            .split_once('#')
            .ok_or_else(|| invalid("请粘贴完整授权码（code#state），或浏览器返回的回调地址。"))?;
        (code.to_string(), state.to_string())
    };
    checked_code(&code, &state, &authorization)?;
    Ok(format!("{code}#{state}"))
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    }
}

/// Codex receives the callback only at the loopback address in its own prompt.
pub(crate) fn local_callback(input: &str, authorization: &str) -> Result<Url, AppError> {
    let authorization =
        Url::parse(authorization).map_err(|_| invalid("当前授权链接不可用，请重新开始。"))?;
    let mut expected = Url::parse(&parameter(&authorization, "redirect_uri")?)
        .map_err(|_| invalid("当前登录未提供本机回调地址，请重新开始。"))?;
    let received = Url::parse(input_text(input)?)
        .map_err(|_| invalid("请粘贴浏览器地址栏中的完整回调地址。"))?;
    if expected.scheme() != "http"
        || !is_loopback(&expected)
        || !expected.username().is_empty()
        || expected.password().is_some()
        || received.scheme() != expected.scheme()
        || received.host() != expected.host()
        || received.port_or_known_default() != expected.port_or_known_default()
        || received.path() != expected.path()
        || !received.username().is_empty()
        || received.password().is_some()
        || received.fragment().is_some()
    {
        return Err(invalid(
            "回调地址与本次登录不匹配，请复制当前浏览器返回的完整地址。",
        ));
    }
    let code = parameter(&received, "code")?;
    let state = parameter(&received, "state")?;
    checked_code(&code, &state, &authorization)?;
    expected.set_query(None);
    expected
        .query_pairs_mut()
        .append_pair("code", &code)
        .append_pair("state", &state);
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    const AUTH: &str = "https://auth.openai.com/oauth/authorize?state=current&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";

    #[test]
    fn manual_input_accepts_codes_and_complete_callback_urls() {
        assert_eq!(
            manual_code(" code-1#current ", AUTH).unwrap(),
            "code-1#current"
        );
        assert_eq!(
            manual_code(
                "https://platform.claude.com/oauth/code/callback?code=code-1&state=current",
                AUTH
            )
            .unwrap(),
            "code-1#current"
        );
        for input in [
            "code#other",
            "code",
            "code#current\nextra",
            "code#current#extra",
            "https://example.test/?code=bad%00code&state=current",
            "https://example.test/?code=a&code=b&state=current",
        ] {
            assert!(manual_code(input, AUTH).is_err(), "{input}");
        }
    }

    #[test]
    fn local_callbacks_are_bound_to_the_current_state_and_loopback_destination() {
        let good = "http://localhost:1455/auth/callback?state=current&code=code-1";
        assert_eq!(
            local_callback(good, AUTH).unwrap().as_str(),
            "http://localhost:1455/auth/callback?code=code-1&state=current"
        );
        for bad in [
            good.replace("current", "old"),
            good.replace(":1455", ":8080"),
            good.replace("localhost", "example.test"),
            good.replace("http:", "https:"),
            good.replace("/auth/callback", "/other"),
            format!("{good}&state=current"),
            format!("{good}#fragment"),
            good.replace("localhost", "user@localhost"),
        ] {
            assert!(local_callback(&bad, AUTH).is_err(), "{bad}");
        }
        assert!(local_callback(good, &AUTH.replace("localhost", "example.test")).is_err());
    }
}
