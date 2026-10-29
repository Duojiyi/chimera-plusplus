//! 全局 HTTP 客户端模块
//!
//! 提供支持全局代理配置的 HTTP 客户端。
//! 所有需要发送 HTTP 请求的模块都应使用此模块提供的客户端。

use once_cell::sync::OnceCell;
use reqwest::Client;
use std::env;
use std::net::IpAddr;
use std::sync::RwLock;
use std::time::Duration;

/// 全局 HTTP 客户端实例
static GLOBAL_CLIENT: OnceCell<RwLock<Client>> = OnceCell::new();

/// 代理转发专用客户端：与全局客户端共用代理配置，但使用
/// [`forward_redirect_policy`]，单独缓存以保留连接池。
static FORWARD_CLIENT: OnceCell<RwLock<Client>> = OnceCell::new();

/// 当前代理 URL（用于日志和状态查询）
static CURRENT_PROXY_URL: OnceCell<RwLock<Option<String>>> = OnceCell::new();

/// CC Switch 代理服务器当前监听的端口
static CC_SWITCH_PROXY_PORT: OnceCell<RwLock<u16>> = OnceCell::new();

/// 设置 CC Switch 代理服务器的监听端口
///
/// 应在代理服务器启动时调用，以便系统代理检测能正确识别自己的端口
pub fn set_proxy_port(port: u16) {
    if let Some(lock) = CC_SWITCH_PROXY_PORT.get() {
        if let Ok(mut current_port) = lock.write() {
            *current_port = port;
            log::debug!("[GlobalProxy] Updated CC Switch proxy port to {port}");
        }
    } else {
        let _ = CC_SWITCH_PROXY_PORT.set(RwLock::new(port));
        log::debug!("[GlobalProxy] Initialized CC Switch proxy port to {port}");
    }
}

/// 获取 CC Switch 代理服务器的监听端口
fn get_proxy_port() -> u16 {
    CC_SWITCH_PROXY_PORT
        .get()
        .and_then(|lock| lock.read().ok())
        .map(|port| *port)
        .unwrap_or(15721) // 默认端口作为回退
}

/// 初始化全局 HTTP 客户端
///
/// 应在应用启动时调用一次。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`
///   传入 None 或空字符串表示直连
pub fn init(proxy_url: Option<&str>) -> Result<(), String> {
    let effective_url = proxy_url.filter(|s| !s.trim().is_empty());
    let client = build_client(effective_url)?;

    // 尝试初始化全局客户端，如果已存在则记录警告并使用 apply_proxy 更新
    if GLOBAL_CLIENT.set(RwLock::new(client.clone())).is_err() {
        log::warn!(
            "[GlobalProxy] [GP-003] Already initialized, updating instead: {}",
            effective_url
                .map(mask_url)
                .unwrap_or_else(|| "direct connection".to_string())
        );
        // 已初始化，改用 apply_proxy 更新
        return apply_proxy(proxy_url);
    }

    refresh_forward_client(effective_url)?;

    // 初始化代理 URL 记录
    let _ = CURRENT_PROXY_URL.set(RwLock::new(effective_url.map(|s| s.to_string())));

    log::info!(
        "[GlobalProxy] Initialized: {}",
        effective_url
            .map(mask_url)
            .unwrap_or_else(|| "direct connection".to_string())
    );

    Ok(())
}

/// 验证代理配置（不应用）
///
/// 只验证代理 URL 是否有效，不实际更新全局客户端。
/// 用于在持久化之前验证配置的有效性。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，None 或空字符串表示直连
///
/// # Returns
/// 验证成功返回 Ok(())，失败返回错误信息
pub fn validate_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let effective_url = proxy_url.filter(|s| !s.trim().is_empty());
    // 只调用 build_client 来验证，但不应用
    build_client(effective_url)?;
    Ok(())
}

/// 应用代理配置（假设已验证）
///
/// 直接应用代理配置到全局客户端，不做额外验证。
/// 应在 validate_proxy 成功后调用。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，None 或空字符串表示直连
pub fn apply_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let effective_url = proxy_url.filter(|s| !s.trim().is_empty());
    let new_client = build_client(effective_url)?;

    // 更新客户端
    if let Some(lock) = GLOBAL_CLIENT.get() {
        let mut client = lock.write().map_err(|e| {
            log::error!("[GlobalProxy] [GP-001] Failed to acquire write lock: {e}");
            "Failed to update proxy: lock poisoned".to_string()
        })?;
        *client = new_client;
    } else {
        // 如果还没初始化，则初始化
        return init(proxy_url);
    }
    refresh_forward_client(effective_url)?;

    // 更新代理 URL 记录
    if let Some(lock) = CURRENT_PROXY_URL.get() {
        let mut url = lock.write().map_err(|e| {
            log::error!("[GlobalProxy] [GP-002] Failed to acquire URL write lock: {e}");
            "Failed to update proxy URL record: lock poisoned".to_string()
        })?;
        *url = effective_url.map(|s| s.to_string());
    }

    log::info!(
        "[GlobalProxy] Applied: {}",
        effective_url
            .map(mask_url)
            .unwrap_or_else(|| "direct connection".to_string())
    );

    Ok(())
}

/// 更新代理配置（热更新）
///
/// 可在运行时调用以更改代理设置，无需重启应用。
/// 注意：此函数同时验证和应用，如果需要先验证后持久化再应用，
/// 请使用 validate_proxy + apply_proxy 组合。
///
/// # Arguments
/// * `proxy_url` - 新的代理 URL，None 或空字符串表示直连
#[allow(dead_code)]
pub fn update_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let effective_url = proxy_url.filter(|s| !s.trim().is_empty());
    let new_client = build_client(effective_url)?;

    // 更新客户端
    if let Some(lock) = GLOBAL_CLIENT.get() {
        let mut client = lock.write().map_err(|e| {
            log::error!("[GlobalProxy] [GP-001] Failed to acquire write lock: {e}");
            "Failed to update proxy: lock poisoned".to_string()
        })?;
        *client = new_client;
    } else {
        // 如果还没初始化，则初始化
        return init(proxy_url);
    }
    refresh_forward_client(effective_url)?;

    // 更新代理 URL 记录
    if let Some(lock) = CURRENT_PROXY_URL.get() {
        let mut url = lock.write().map_err(|e| {
            log::error!("[GlobalProxy] [GP-002] Failed to acquire URL write lock: {e}");
            "Failed to update proxy URL record: lock poisoned".to_string()
        })?;
        *url = effective_url.map(|s| s.to_string());
    }

    log::info!(
        "[GlobalProxy] Updated: {}",
        effective_url
            .map(mask_url)
            .unwrap_or_else(|| "direct connection".to_string())
    );

    Ok(())
}

/// 获取全局 HTTP 客户端
///
/// 返回配置了代理的客户端（如果已配置代理），否则返回跟随系统代理的客户端。
pub fn get() -> Client {
    GLOBAL_CLIENT
        .get()
        .and_then(|lock| lock.read().ok())
        .map(|c| c.clone())
        .unwrap_or_else(|| {
            log::warn!("[GlobalProxy] [GP-004] Client not initialized, using fallback");
            build_client(None).unwrap_or_default()
        })
}

/// 为携带认证信息的模型发现及协议探测构建专用客户端。
///
/// 复用全局代理、连接和超时配置，但不跟随任何重定向：reqwest 的跨源
/// 认证头保护不包括 x-api-key。构建失败直接返回错误，不能退回宽松客户端。
pub fn get_for_auth_probe() -> Result<Client, String> {
    build_client_with_redirect_policy(
        get_current_proxy_url().as_deref(),
        reqwest::redirect::Policy::none(),
    )
}

/// 获取代理转发（`forwarder`）使用的客户端。
///
/// 与 [`get`] 共用代理配置，但重定向只允许同主机的 http→https 升级，
/// 跨主机重定向一律拒绝：转发请求带着供应商凭据（`x-api-key` 等不在
/// reqwest 跨源剥离范围内），上游不能借 3xx 把它们引到别的主机。
/// 其它调用方（技能/运行时下载等）仍用 [`get`]，它们需要跟随 CDN 重定向。
pub fn get_for_forwarding() -> Client {
    FORWARD_CLIENT
        .get()
        .and_then(|lock| lock.read().ok())
        .map(|c| c.clone())
        .unwrap_or_else(|| {
            log::warn!("[GlobalProxy] [GP-005] Forward client not initialized, using fallback");
            build_forward_client(get_current_proxy_url().as_deref()).unwrap_or_else(|_| {
                Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap_or_default()
            })
        })
}

/// 下载安装包、皮肤包等大文件使用的客户端。
///
/// 与 [`get`] 共用代理配置（应用代理，否则跟随系统代理），但重定向链上的
/// 每一跳都必须是 HTTPS：默认策略允许 https→http→https，明文那一跳可被
/// 篡改，把下载引到任意 HTTPS 主机。构建失败直接返回错误，不退回宽松客户端。
/// 代理转发客户端的重定向策略不受影响。
///
/// 决定安装或信任什么的请求也用它：Skill 压缩包、皮肤目录、Codex 镜像的
/// 发布清单与校验和。
pub fn get_for_download() -> Result<Client, String> {
    build_download_client(get_current_proxy_url().as_deref())
}

fn build_download_client(proxy_url: Option<&str>) -> Result<Client, String> {
    build_client_with_redirect_policy(proxy_url, https_only_redirect_policy())
}

/// 与 reqwest 默认策略相同的跳数上限。
const MAX_DOWNLOAD_REDIRECTS: usize = 10;

/// 每一跳都必须是 HTTPS，最多跟随 [`MAX_DOWNLOAD_REDIRECTS`] 次。
pub(crate) fn https_only_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() != "https" {
            attempt.error("download redirect refused: every hop must use HTTPS")
        } else if attempt.previous().len() >= MAX_DOWNLOAD_REDIRECTS {
            attempt.error("download redirect refused: too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// 同主机 http→https 升级之外的重定向一律拒绝（MH-8e）。
fn forward_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let allowed = attempt
            .previous()
            .last()
            .is_some_and(|previous| is_same_host_https_upgrade(previous, attempt.url()));
        if allowed {
            attempt.follow()
        } else {
            attempt
                .error("upstream redirect refused: only a same-host http→https upgrade is allowed")
        }
    })
}

fn is_same_host_https_upgrade(previous: &reqwest::Url, next: &reqwest::Url) -> bool {
    previous.scheme() == "http"
        && next.scheme() == "https"
        && previous.host_str().is_some()
        && previous.host_str() == next.host_str()
}

fn build_forward_client(proxy_url: Option<&str>) -> Result<Client, String> {
    build_client_with_redirect_policy(proxy_url, forward_redirect_policy())
}

fn refresh_forward_client(proxy_url: Option<&str>) -> Result<(), String> {
    let client = build_forward_client(proxy_url)?;
    match FORWARD_CLIENT.get() {
        Some(lock) => {
            let mut current = lock.write().map_err(|e| {
                log::error!("[GlobalProxy] [GP-006] Failed to acquire forward client lock: {e}");
                "Failed to update proxy: lock poisoned".to_string()
            })?;
            *current = client;
        }
        None => {
            let _ = FORWARD_CLIENT.set(RwLock::new(client));
        }
    }
    Ok(())
}

/// 获取当前代理 URL
///
/// 返回当前配置的代理 URL，None 表示直连。
pub fn get_current_proxy_url() -> Option<String> {
    CURRENT_PROXY_URL
        .get()
        .and_then(|lock| lock.read().ok())
        .and_then(|url| url.clone())
}

/// 检查是否正在使用代理
#[allow(dead_code)]
pub fn is_proxy_enabled() -> bool {
    get_current_proxy_url().is_some()
}

/// 用户可见的当前出站网络方式，与 [`get`] 选择代理的规则一致，凭据已脱敏。
///
/// 下载失败时附在错误里，让用户知道这次请求实际走的是应用代理、系统代理还是直连。
pub(crate) fn describe_network_mode() -> String {
    network_mode_label(
        get_current_proxy_url().as_deref(),
        system_proxy_points_to_loopback(),
    )
}

fn network_mode_label(proxy_url: Option<&str>, loopback_bypassed: bool) -> String {
    match proxy_url {
        Some(url) => format!("应用代理 {}", mask_url(url)),
        None if loopback_bypassed => {
            "未设置应用代理；系统代理指向本应用自身端口，已改为直连".to_string()
        }
        None => "未设置应用代理，跟随系统代理设置".to_string(),
    }
}

/// 构建 HTTP 客户端
fn build_client(proxy_url: Option<&str>) -> Result<Client, String> {
    build_client_with_redirect_policy(proxy_url, reqwest::redirect::Policy::default())
}

fn build_client_with_redirect_policy(
    proxy_url: Option<&str>,
    redirect_policy: reqwest::redirect::Policy,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(redirect_policy)
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(Duration::from_secs(60))
        // 禁用 reqwest 自动解压：防止 reqwest 覆盖客户端原始 accept-encoding header。
        // 响应解压由 response_processor 根据 content-encoding 手动处理。
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd();

    // 有代理地址则使用代理，否则跟随系统代理
    if let Some(url) = proxy_url {
        // 先验证 URL 格式和 scheme
        let parsed = url::Url::parse(url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", mask_url(url), e))?;

        let scheme = parsed.scheme();
        if !["http", "https", "socks5", "socks5h"].contains(&scheme) {
            return Err(format!(
                "Invalid proxy scheme '{}' in URL '{}'. Supported: http, https, socks5, socks5h",
                scheme,
                mask_url(url)
            ));
        }

        // 显式代理会关掉 reqwest 对 NO_PROXY 的处理，本机推理服务（Ollama、
        // LM Studio、vLLM）的请求会被送进代理而失败：本机地址始终直连，
        // 用户设置的 NO_PROXY 继续生效。
        // Adapted from BigPizzaV3/CodexPlusPlus 78162cbc
        let no_proxy = explicit_proxy_no_proxy_rules(user_no_proxy_from_env().as_deref());
        let proxy = reqwest::Proxy::all(url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", mask_url(url), e))?
            .no_proxy(reqwest::NoProxy::from_string(&no_proxy));
        builder = builder.proxy(proxy);
        log::debug!("[GlobalProxy] Proxy configured: {}", mask_url(url));
    } else {
        // 未设置全局代理时，让 reqwest 自动检测系统代理（环境变量）
        // 若系统代理指向本机，禁用系统代理避免自环
        if system_proxy_points_to_loopback() {
            builder = builder.no_proxy();
            log::warn!(
                "[GlobalProxy] System proxy points to localhost, bypassing to avoid recursion"
            );
        } else {
            log::debug!("[GlobalProxy] Following system proxy (no explicit proxy configured)");
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// 显式应用代理下始终直连的本机地址。
const LOOPBACK_NO_PROXY: &str = "localhost,127.0.0.0/8,::1";

/// 显式应用代理的直连规则：本机地址加上用户自己的 NO_PROXY（如有）。
fn explicit_proxy_no_proxy_rules(user_no_proxy: Option<&str>) -> String {
    match user_no_proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(user) => format!("{LOOPBACK_NO_PROXY},{user}"),
        None => LOOPBACK_NO_PROXY.to_string(),
    }
}

fn user_no_proxy_from_env() -> Option<String> {
    ["NO_PROXY", "no_proxy"]
        .iter()
        .find_map(|key| env::var(key).ok().filter(|value| !value.trim().is_empty()))
}

fn system_proxy_points_to_loopback() -> bool {
    const KEYS: [&str; 6] = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ];

    KEYS.iter()
        .filter_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .any(|value| proxy_points_to_loopback(&value))
}

fn proxy_points_to_loopback(value: &str) -> bool {
    fn host_is_loopback(host: &str) -> bool {
        if host.eq_ignore_ascii_case("localhost") {
            return true;
        }
        host.parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
    }

    // 检查是否指向 CC Switch 自己的代理端口
    // 只有指向自己的代理才需要跳过，避免递归
    fn is_cc_switch_proxy_port(port: Option<u16>) -> bool {
        let cc_switch_port = get_proxy_port();
        port == Some(cc_switch_port)
    }

    if let Ok(parsed) = url::Url::parse(value) {
        if let Some(host) = parsed.host_str() {
            // 只有当主机是 loopback 且端口是 CC Switch 的端口时才返回 true
            return host_is_loopback(host) && is_cc_switch_proxy_port(parsed.port());
        }
        return false;
    }

    let with_scheme = format!("http://{value}");
    if let Ok(parsed) = url::Url::parse(&with_scheme) {
        if let Some(host) = parsed.host_str() {
            return host_is_loopback(host) && is_cc_switch_proxy_port(parsed.port());
        }
    }

    false
}

/// 隐藏 URL 中的敏感信息（用于日志）
pub fn mask_url(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        // 隐藏用户名和密码，保留 scheme、host 和端口
        let host = parsed.host_str().unwrap_or("?");
        match parsed.port() {
            Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
            None => format!("{}://{}", parsed.scheme(), host),
        }
    } else {
        // URL 解析失败，返回部分内容
        if url.len() > 20 {
            let boundary = (0..=20)
                .rev()
                .find(|&index| url.is_char_boundary(index))
                .unwrap_or(0);
            format!("{}...", &url[..boundary])
        } else {
            url.to_string()
        }
    }
}

/// A redirect to plain HTTP, served for the production download client.
///
/// Shared by the tests of every fetch that goes through [`get_for_download`].
/// The fixture is an explicit HTTP proxy, as in the auth-probe test below:
/// the `.invalid` hosts never resolve, and proxies from the environment
/// cannot interfere.
#[cfg(test)]
pub(crate) mod download_redirect_fixture {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Answered with a temporary redirect to [`TARGET_URL`].
    pub(crate) const START_URL: &str = "http://origin.invalid/start";
    /// Plain HTTP: a download client must never request it after a redirect.
    pub(crate) const TARGET_URL: &str = "http://target.invalid/payload";

    pub(crate) struct Fixture {
        /// [`super::get_for_download`]'s client, routed through the fixture.
        pub(crate) client: reqwest::Client,
        target_hits: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Fixture {
        /// Requests that reached [`TARGET_URL`].
        pub(crate) fn target_hits(&self) -> usize {
            self.target_hits.load(Ordering::SeqCst)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    pub(crate) async fn start() -> Fixture {
        use axum::response::IntoResponse;

        let target_hits = Arc::new(AtomicUsize::new(0));
        let hits = target_hits.clone();
        let router = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let hits = hits.clone();
            async move {
                if uri.path() == "/start" {
                    axum::response::Redirect::temporary(TARGET_URL).into_response()
                } else {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "served over plain HTTP".into_response()
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the fixture proxy");
        let proxy_url = format!("http://{}", listener.local_addr().expect("fixture address"));
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve the fixture");
        });
        Fixture {
            client: super::build_download_client(Some(&proxy_url))
                .expect("build the download client"),
            target_hits,
            server,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mask_invalid_unicode_url_does_not_split_codepoints() {
        assert_eq!(mask_url("无效代理地址无效代理地址"), "无效代理地址...");
        assert_eq!(mask_url("short invalid"), "short invalid");
    }

    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn test_mask_url() {
        assert_eq!(mask_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(
            mask_url("http://user:pass@127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            mask_url("socks5://admin:secret@proxy.example.com:1080"),
            "socks5://proxy.example.com:1080"
        );
        // 无端口的 URL 不应显示 ":?"
        assert_eq!(
            mask_url("http://proxy.example.com"),
            "http://proxy.example.com"
        );
        assert_eq!(
            mask_url("https://user:pass@proxy.example.com"),
            "https://proxy.example.com"
        );
    }

    #[tokio::test]
    async fn auth_probe_policy_preserves_proxy_and_leaves_normal_redirects_unchanged() {
        use axum::response::IntoResponse;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let destination_hits = Arc::new(AtomicUsize::new(0));
        let hits = destination_hits.clone();
        let router = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let hits = hits.clone();
            async move {
                if uri.path() == "/start" {
                    axum::response::Redirect::temporary("http://redirect.invalid/target")
                        .into_response()
                } else {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "target".into_response()
                }
            }
        });
        // Act as an explicit HTTP proxy. The .invalid hosts must never resolve:
        // a successful response proves the selected client retained the proxy.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let probe =
            build_client_with_redirect_policy(Some(&proxy_url), reqwest::redirect::Policy::none())
                .unwrap()
                .get("http://probe.invalid/start")
                .timeout(Duration::from_secs(3))
                .send()
                .await;
        let hits_after_probe = destination_hits.load(Ordering::SeqCst);
        let ordinary = build_client(Some(&proxy_url))
            .unwrap()
            .get("http://probe.invalid/start")
            .timeout(Duration::from_secs(3))
            .send()
            .await;
        server.abort();

        assert_eq!(
            probe.unwrap().status(),
            reqwest::StatusCode::TEMPORARY_REDIRECT
        );
        assert_eq!(hits_after_probe, 0);
        assert_eq!(ordinary.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(destination_hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn explicit_proxy_always_bypasses_loopback_and_keeps_user_no_proxy() {
        assert_eq!(
            explicit_proxy_no_proxy_rules(None),
            "localhost,127.0.0.0/8,::1"
        );
        assert_eq!(
            explicit_proxy_no_proxy_rules(Some("  ")),
            "localhost,127.0.0.0/8,::1"
        );
        assert_eq!(
            explicit_proxy_no_proxy_rules(Some(" example.com,10.0.0.0/8 ")),
            "localhost,127.0.0.0/8,::1,example.com,10.0.0.0/8"
        );
    }

    #[tokio::test]
    async fn explicit_proxy_is_not_used_for_loopback_targets() {
        let router = axum::Router::new().fallback(|| async { "local model" });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        // Nothing listens on the discard port: a request sent to this proxy fails.
        let client = build_client(Some("http://127.0.0.1:9")).unwrap();
        let response = client
            .get(format!("http://{address}/v1/models"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .expect("a loopback target is reached directly");
        let status = response.status();
        let body = response.text().await.unwrap();
        server.abort();

        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(body, "local model");
    }

    #[tokio::test]
    async fn forward_client_refuses_cross_host_redirects() {
        use axum::response::IntoResponse;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let destination_hits = Arc::new(AtomicUsize::new(0));
        let hits = destination_hits.clone();
        let router = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let hits = hits.clone();
            async move {
                match uri.path() {
                    "/cross" => {
                        axum::response::Redirect::temporary("http://attacker.invalid/steal")
                            .into_response()
                    }
                    "/same-host-http" => {
                        axum::response::Redirect::temporary("http://origin.invalid/steal")
                            .into_response()
                    }
                    _ => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        "target".into_response()
                    }
                }
            }
        });
        // Explicit HTTP proxy, as in the auth-probe test: .invalid hosts never resolve.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let client = build_forward_client(Some(&proxy_url)).unwrap();
        let mut results = Vec::new();
        for path in ["/cross", "/same-host-http"] {
            results.push(
                client
                    .post(format!("http://origin.invalid{path}"))
                    .header("x-api-key", "sk-must-not-leave")
                    .timeout(Duration::from_secs(3))
                    .send()
                    .await,
            );
        }
        server.abort();

        for result in results {
            let error = result.expect_err("redirect must be refused, not followed");
            assert!(error.is_redirect(), "{error}");
        }
        assert_eq!(destination_hits.load(Ordering::SeqCst), 0);
    }

    /// The rule covers redirect hops only: a plain-HTTP hop is refused before
    /// it is requested, while a URL the caller chose is fetched as before.
    #[tokio::test]
    async fn download_client_refuses_plain_http_hops_but_not_the_first_url() {
        use super::download_redirect_fixture::{start, START_URL, TARGET_URL};

        let fixture = start().await;
        let error = fixture
            .client
            .get(START_URL)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .expect_err("a plain-HTTP hop must be refused, not followed");
        assert!(error.is_redirect(), "{error}");
        assert_eq!(fixture.target_hits(), 0);

        let direct = fixture
            .client
            .get(TARGET_URL)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .expect("the first URL itself is not a redirect hop");
        assert_eq!(direct.status(), reqwest::StatusCode::OK);
        assert_eq!(fixture.target_hits(), 1);
    }

    #[test]
    fn forward_redirects_allow_only_same_host_https_upgrade() {
        let url = |s: &str| reqwest::Url::parse(s).unwrap();
        assert!(is_same_host_https_upgrade(
            &url("http://api.example.com/v1/responses"),
            &url("https://api.example.com/v1/responses"),
        ));
        for (previous, next) in [
            ("http://api.example.com/v1", "https://evil.example.net/v1"),
            ("http://api.example.com/v1", "http://api.example.com/v2"),
            ("https://api.example.com/v1", "https://api.example.com/v2"),
            ("https://api.example.com/v1", "http://api.example.com/v1"),
            (
                "http://api.example.com/v1",
                "https://sub.api.example.com/v1",
            ),
        ] {
            assert!(
                !is_same_host_https_upgrade(&url(previous), &url(next)),
                "{previous} -> {next}"
            );
        }
    }

    #[test]
    fn network_mode_label_masks_credentials_and_names_the_route() {
        assert_eq!(
            network_mode_label(Some("http://user:secret@127.0.0.1:7890"), false),
            "应用代理 http://127.0.0.1:7890"
        );
        assert_eq!(
            network_mode_label(None, false),
            "未设置应用代理，跟随系统代理设置"
        );
        assert!(network_mode_label(None, true).contains("已改为直连"));
    }

    #[test]
    fn test_build_client_direct() {
        let result = build_client(None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_with_http_proxy() {
        let result = build_client(Some("http://127.0.0.1:7890"));
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_with_socks5_proxy() {
        let result = build_client(Some("socks5://127.0.0.1:1080"));
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_invalid_url() {
        // reqwest::Proxy::all 对某些无效 URL 不会立即报错
        // 使用明确无效的 scheme 来触发错误
        let result = build_client(Some("invalid-scheme://127.0.0.1:7890"));
        assert!(result.is_err(), "Should reject invalid proxy scheme");
    }

    #[test]
    fn test_proxy_points_to_loopback() {
        // 设置 CC Switch 代理端口为 15721（默认值）
        set_proxy_port(15721);

        // 只有指向 CC Switch 自己端口的 loopback 地址才返回 true
        assert!(proxy_points_to_loopback("http://127.0.0.1:15721"));
        assert!(proxy_points_to_loopback("socks5://localhost:15721"));
        assert!(proxy_points_to_loopback("127.0.0.1:15721"));

        // 其他 loopback 端口不应该被跳过（允许使用其他本地代理工具）
        assert!(!proxy_points_to_loopback("http://127.0.0.1:7890"));
        assert!(!proxy_points_to_loopback("socks5://localhost:1080"));

        // 非 loopback 地址不应该被跳过
        assert!(!proxy_points_to_loopback("http://192.168.1.10:7890"));
        assert!(!proxy_points_to_loopback("http://192.168.1.10:15721"));
    }

    #[test]
    fn test_system_proxy_points_to_loopback() {
        let _guard = env_lock().lock().unwrap();

        // 设置 CC Switch 代理端口
        set_proxy_port(15721);

        let keys = [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ];

        for key in &keys {
            std::env::remove_var(key);
        }

        // 指向 CC Switch 端口的代理应该被跳过
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:15721");
        assert!(system_proxy_points_to_loopback());

        // 指向其他端口的本地代理不应该被跳过
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:7890");
        assert!(!system_proxy_points_to_loopback());

        // 非 loopback 地址不应该被跳过
        std::env::set_var("HTTP_PROXY", "http://10.0.0.2:7890");
        assert!(!system_proxy_points_to_loopback());

        for key in &keys {
            std::env::remove_var(key);
        }
    }
}
