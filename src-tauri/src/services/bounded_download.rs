//! Bounded, proxy-consistent streaming downloads for large payloads.
//!
//! The Codex package and skin packages used to be fetched by the pinned
//! engine's curl while update checks and catalogs went through the shared
//! reqwest client, and the two disagreed about proxies: without an app proxy
//! the package download was forced direct and skin downloads ignored the app
//! proxy entirely. Users behind a system proxy could see "Codex X available"
//! and then fail to download it. Payload downloads now use the client the
//! caller passes in (production passes `proxy::http_client::get()`), so checks
//! and downloads share one proxy and TLS stack.
//!
//! Bytes land in `<dest>.part` and are renamed into place only after exactly
//! the expected size arrived; every failure removes the partial file.
//! Integrity checks (SHA-256, signatures) stay with the caller.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Some CDNs reject requests without a User-Agent.
const DOWNLOAD_USER_AGENT: &str = "chimera-plus-plus";
/// Coalesces small network frames into fewer disk writes.
const WRITE_BUFFER_BYTES: usize = 256 * 1024;

/// Tunables for one download. Durations are injectable so tests can exercise
/// stalls and retries in milliseconds.
#[derive(Debug, Clone)]
pub struct DownloadOptions {
    /// Upper bound for one attempt, from connecting until the last byte. It
    /// overrides the shared client's 600-second total timeout, which is far
    /// too short for a package of several hundred megabytes.
    pub total_timeout: Duration,
    /// Longest silence tolerated while waiting for the response headers or
    /// for the next body chunk.
    pub stall_timeout: Duration,
    /// Extra attempts after a transport failure; each restarts from zero.
    pub max_retries: u32,
    /// Base delay before a retry, multiplied by the retry number.
    pub retry_delay: Duration,
    /// Minimum number of new bytes between progress callbacks. Each callback
    /// becomes a Tauri event, so per-chunk reporting would flood the renderer.
    pub progress_step: u64,
    /// Minimum time between progress callbacks, so fast links do not emit
    /// hundreds of events per second. The final size is always reported.
    pub progress_interval: Duration,
    /// Refuse plain-HTTP URLs, including the final URL after redirects. The
    /// engine's curl enforced this with `--proto =https --proto-redir =https`.
    pub require_https: bool,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            total_timeout: Duration::from_secs(2 * 60 * 60),
            stall_timeout: Duration::from_secs(60),
            max_retries: 2,
            retry_delay: Duration::from_secs(2),
            progress_step: 512 * 1024,
            progress_interval: Duration::from_millis(200),
            require_https: true,
        }
    }
}

/// Why a download failed.
///
/// `Display` is a plain-Chinese cause without the URL: redirect targets can
/// carry short-lived signed query strings. Callers add what was downloaded,
/// the network mode and the next step.
#[derive(Debug)]
pub enum DownloadError {
    /// The URL could not be parsed.
    InvalidUrl(String),
    /// The URL, or the final URL after redirects, is not HTTPS.
    InsecureUrl,
    /// The server answered with a non-success status.
    HttpStatus(reqwest::StatusCode),
    /// The declared `Content-Length` differs from the expected size.
    DeclaredSize { expected: u64, declared: u64 },
    /// More bytes arrived than expected.
    TooLarge { expected: u64 },
    /// The body ended before the expected size was reached.
    SizeMismatch { expected: u64, actual: u64 },
    /// No data arrived within the stall timeout.
    Stalled(Duration),
    /// Connection, TLS, proxy or mid-body transport failure.
    Transport { message: String, retryable: bool },
    /// Local file system failure.
    Io(String),
    /// The last failure after the automatic retries were used up.
    Retried {
        retries: u32,
        last: Box<DownloadError>,
    },
}

impl DownloadError {
    fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Stalled(_)
                | Self::Transport {
                    retryable: true,
                    ..
                }
        )
    }

    fn transport(error: &reqwest::Error) -> Self {
        Self::Transport {
            message: describe_reqwest_error(error),
            // Builder (bad URL) and redirect-policy errors repeat identically.
            retryable: !(error.is_builder() || error.is_redirect()),
        }
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(reason) => write!(f, "下载地址无效（{reason}）"),
            Self::InsecureUrl => f.write_str("下载地址不是 HTTPS，已拒绝"),
            Self::HttpStatus(status) => {
                write!(f, "服务器返回 HTTP {status}{}", status_hint(*status))
            }
            Self::DeclaredSize { expected, declared } if declared > expected => write!(
                f,
                "服务器声明的文件大小（{declared} 字节）超过预期的 {expected} 字节，已拒绝下载"
            ),
            Self::DeclaredSize { expected, declared } => write!(
                f,
                "服务器声明的文件大小（{declared} 字节）与预期的 {expected} 字节不符，已拒绝下载"
            ),
            Self::TooLarge { expected } => {
                write!(f, "收到的数据超过预期的 {expected} 字节，已中止下载")
            }
            Self::SizeMismatch { expected, actual } => {
                write!(
                    f,
                    "下载内容不完整：收到 {actual} 字节，预期 {expected} 字节"
                )
            }
            Self::Stalled(timeout) => write!(
                f,
                "超过 {}没有收到任何数据，连接可能已中断",
                format_duration(*timeout)
            ),
            Self::Transport { message, .. } | Self::Io(message) => f.write_str(message),
            Self::Retried { retries, last } => write!(f, "{last}（已自动重试 {retries} 次）"),
        }
    }
}

fn status_hint(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        404 | 410 => "（文件不存在或已被移除）",
        401 | 403 => "（服务器拒绝访问，可能是请求过于频繁或被网络策略拦截）",
        429 => "（请求过于频繁）",
        500..=599 => "（服务器暂时不可用）",
        _ => "",
    }
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds > 0 {
        format!("{seconds} 秒")
    } else {
        format!("{} 毫秒", duration.as_millis())
    }
}

/// Plain-Chinese summary of a reqwest failure followed by its cause chain.
///
/// The top-level `Display` of a reqwest error embeds the request URL, which
/// for redirected downloads can include signed query strings, so only the
/// sources are appended. They carry the useful part (refused connection,
/// certificate or proxy failures) and are localized by the OS where possible.
pub fn describe_reqwest_error(error: &reqwest::Error) -> String {
    let summary = if error.is_timeout() {
        "网络请求超时"
    } else if error.is_connect() {
        "无法连接到服务器"
    } else if error.is_redirect() {
        "服务器重定向无效或次数过多"
    } else if error.is_builder() {
        "请求地址无效"
    } else if error.is_body() || error.is_decode() {
        "接收数据时连接中断"
    } else {
        "网络请求失败"
    };
    let mut causes: Vec<String> = Vec::new();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let text = cause.to_string();
        let text = text.trim();
        if !text.is_empty() && !causes.iter().any(|seen| seen == text) {
            causes.push(text.to_string());
        }
        source = std::error::Error::source(cause);
    }
    if causes.is_empty() {
        summary.to_string()
    } else {
        format!("{summary}（{}）", causes.join("："))
    }
}

/// The staging file a download writes before it is published as `dest`.
pub fn partial_path(dest: &Path) -> PathBuf {
    let file_name = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    dest.with_file_name(format!("{file_name}.part"))
}

fn discard_partial(part: &Path) {
    if let Err(error) = std::fs::remove_file(part) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "[download] 清理未完成的下载文件失败 {}: {error}",
                part.display()
            );
        }
    }
}

fn publish(part: &Path, dest: &Path) -> Result<(), DownloadError> {
    let Err(first) = std::fs::rename(part, dest) else {
        return Ok(());
    };
    // `rename` replaces an existing file on every platform, but Windows still
    // refuses a read-only target; remove it and try once more.
    if dest.is_file() && std::fs::remove_file(dest).is_ok() {
        return std::fs::rename(part, dest)
            .map_err(|error| DownloadError::Io(format!("保存下载文件失败：{error}")));
    }
    Err(DownloadError::Io(format!("保存下载文件失败：{first}")))
}

/// Progress callback shared with the task that runs the download.
pub type ProgressCallback = std::sync::Arc<dyn Fn(u64) + Send + Sync>;

/// Stream `url` into `dest`, accepting exactly `expected_size` bytes.
///
/// Writes go to `<dest>.part`, which is renamed to `dest` only after the
/// full size arrived and is removed on every failure. Transport failures and
/// stalls are retried from a clean start up to `options.max_retries` times;
/// HTTP errors and size violations are not.
///
/// File writes are synchronous buffered writes, as in the rest of the
/// download code; they are short compared with the network waits.
pub async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_size: u64,
    options: &DownloadOptions,
    on_progress: &(dyn Fn(u64) + Sync),
) -> Result<(), DownloadError> {
    let url =
        reqwest::Url::parse(url).map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
    if options.require_https && url.scheme() != "https" {
        return Err(DownloadError::InsecureUrl);
    }
    let host = url.host_str().unwrap_or_default().to_string();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| DownloadError::Io(format!("无法创建下载目录：{error}")))?;
    }
    let part = partial_path(dest);
    log::info!("[download] 开始下载 host={host} bytes={expected_size}");
    let mut retries = 0_u32;
    loop {
        let started = Instant::now();
        let attempt =
            download_attempt(client, &url, &part, expected_size, options, on_progress).await;
        let Err(error) = attempt else {
            break;
        };
        // The attempt has returned, so its file handle is closed already.
        discard_partial(&part);
        let budget_left = started.elapsed() < options.total_timeout;
        if error.is_retryable() && budget_left && retries < options.max_retries {
            retries += 1;
            log::warn!("[download] host={host} 第 {retries} 次重试，上次失败：{error}");
            on_progress(0);
            tokio::time::sleep(options.retry_delay.saturating_mul(retries)).await;
            continue;
        }
        log::warn!("[download] host={host} 下载失败：{error}");
        return Err(if retries > 0 {
            DownloadError::Retried {
                retries,
                last: Box::new(error),
            }
        } else {
            error
        });
    }
    if let Err(error) = publish(&part, dest) {
        discard_partial(&part);
        return Err(error);
    }
    log::info!("[download] 下载完成 host={host} bytes={expected_size} retries={retries}");
    Ok(())
}

async fn download_attempt(
    client: &reqwest::Client,
    url: &reqwest::Url,
    part: &Path,
    expected: u64,
    options: &DownloadOptions,
    on_progress: &(dyn Fn(u64) + Sync),
) -> Result<(), DownloadError> {
    let request = client
        .get(url.clone())
        .header(reqwest::header::USER_AGENT, DOWNLOAD_USER_AGENT)
        .timeout(options.total_timeout)
        .send();
    let mut response = match tokio::time::timeout(options.stall_timeout, request).await {
        Err(_) => return Err(DownloadError::Stalled(options.stall_timeout)),
        Ok(Err(error)) => return Err(DownloadError::transport(&error)),
        Ok(Ok(response)) => response,
    };
    if options.require_https && response.url().scheme() != "https" {
        return Err(DownloadError::InsecureUrl);
    }
    let status = response.status();
    if !status.is_success() {
        return Err(DownloadError::HttpStatus(status));
    }
    // Reject a wrong declared size before creating any file.
    if let Some(declared) = response.content_length() {
        if declared != expected {
            return Err(DownloadError::DeclaredSize { expected, declared });
        }
    }

    let file = std::fs::File::create(part)
        .map_err(|error| DownloadError::Io(format!("无法创建临时下载文件：{error}")))?;
    let mut writer = std::io::BufWriter::with_capacity(WRITE_BUFFER_BYTES, file);
    let step = options.progress_step.max(1);
    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    let mut reported_at = Instant::now();
    loop {
        let chunk = match tokio::time::timeout(options.stall_timeout, response.chunk()).await {
            Err(_) => return Err(DownloadError::Stalled(options.stall_timeout)),
            Ok(Err(error)) => return Err(DownloadError::transport(&error)),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => chunk,
        };
        let length = chunk.len() as u64;
        if length > expected.saturating_sub(received) {
            return Err(DownloadError::TooLarge { expected });
        }
        writer
            .write_all(&chunk)
            .map_err(|error| DownloadError::Io(format!("写入下载文件失败：{error}")))?;
        received += length;
        if received - reported >= step && reported_at.elapsed() >= options.progress_interval {
            reported = received;
            reported_at = Instant::now();
            on_progress(received);
        }
    }
    writer
        .flush()
        .map_err(|error| DownloadError::Io(format!("写入下载文件失败：{error}")))?;
    drop(writer);
    if received != expected {
        return Err(DownloadError::SizeMismatch {
            expected,
            actual: received,
        });
    }
    if reported != received {
        on_progress(received);
    }
    Ok(())
}

/// Wrapper for callers that already run on a blocking thread, such as a
/// `spawn_blocking` closure that holds the Codex runtime operation lock.
///
/// The download runs as a task on the shared Tauri runtime, where the HTTP
/// client's connections live; this thread only waits for its result. Call it
/// only from blocking threads: waiting here would stall an async worker.
pub fn download_to_file_blocking(
    client: reqwest::Client,
    url: String,
    dest: PathBuf,
    expected_size: u64,
    options: DownloadOptions,
    on_progress: ProgressCallback,
) -> Result<(), DownloadError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let result =
            download_to_file(&client, &url, &dest, expected_size, &options, &*on_progress).await;
        // The receiver is gone only if the waiting thread was torn down.
        let _ = sender.send(result);
    });
    receiver
        .recv()
        .unwrap_or_else(|_| Err(DownloadError::Io("下载任务被意外中断，请重试".to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// What the loopback server does with one accepted connection.
    enum Reply {
        /// Read the request, then close without answering.
        Hangup,
        /// Send these bytes, then close.
        Send(Vec<u8>),
        /// Send these bytes, stay silent for the given time, then close.
        SendThenStall(Vec<u8>, Duration),
    }

    struct TestServer {
        url: String,
        connections: Arc<AtomicUsize>,
    }

    /// A raw HTTP/1.1 server on 127.0.0.1 that answers one connection per
    /// scripted reply. Raw sockets give exact control over Content-Length,
    /// early closes and silences, which a framework server would normalize.
    fn serve(replies: Vec<Reply>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let address = listener.local_addr().expect("listener address");
        let connections = Arc::new(AtomicUsize::new(0));
        let accepted = connections.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                accepted.fetch_add(1, Ordering::SeqCst);
                read_request_head(&mut stream);
                match reply {
                    Reply::Hangup => {}
                    Reply::Send(bytes) => {
                        let _ = stream.write_all(&bytes);
                        let _ = stream.flush();
                    }
                    Reply::SendThenStall(bytes, pause) => {
                        let _ = stream.write_all(&bytes);
                        let _ = stream.flush();
                        std::thread::sleep(pause);
                    }
                }
            }
        });
        TestServer {
            url: format!("http://{address}/payload.bin"),
            connections,
        }
    }

    fn read_request_head(stream: &mut TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") && request.len() < 64 * 1024 {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&buffer[..read]),
            }
        }
    }

    fn http_response(status: &str, content_length: Option<usize>, body: &[u8]) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {status}\r\nconnection: close\r\ncontent-type: application/octet-stream\r\n"
        );
        if let Some(length) = content_length {
            head.push_str(&format!("content-length: {length}\r\n"));
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn payload(length: usize) -> Vec<u8> {
        (0..length).map(|index| (index % 251) as u8).collect()
    }

    /// The shared client follows system and environment proxies, and other
    /// tests in this binary set HTTP_PROXY; loopback requests must go direct.
    fn loopback_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build a proxy-less client")
    }

    fn test_options() -> DownloadOptions {
        DownloadOptions {
            total_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(10),
            max_retries: 0,
            retry_delay: Duration::from_millis(10),
            progress_step: 256,
            progress_interval: Duration::ZERO,
            require_https: false,
        }
    }

    fn assert_nothing_left(dest: &Path) {
        assert!(!dest.exists(), "no destination file may be published");
        assert!(
            !partial_path(dest).exists(),
            "no partial file may be left behind"
        );
    }

    #[test]
    fn production_defaults_match_the_package_download_contract() {
        let options = DownloadOptions::default();
        assert_eq!(options.total_timeout, Duration::from_secs(7200));
        assert_eq!(options.stall_timeout, Duration::from_secs(60));
        assert_eq!(options.max_retries, 2);
        assert_eq!(options.progress_step, 512 * 1024);
        assert!(options.progress_interval > Duration::ZERO);
        assert!(options.require_https);
    }

    #[tokio::test]
    async fn downloads_the_exact_size_and_reports_progress_up_to_the_total() {
        let body = payload(4096);
        let server = serve(vec![Reply::Send(http_response(
            "200 OK",
            Some(body.len()),
            &body,
        ))]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("downloads").join("package.bin");
        let seen = Mutex::new(Vec::new());
        let on_progress = |downloaded: u64| seen.lock().expect("progress log").push(downloaded);

        download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            body.len() as u64,
            &test_options(),
            &on_progress,
        )
        .await
        .expect("download succeeds");

        assert_eq!(std::fs::read(&dest).expect("read download"), body);
        assert!(!partial_path(&dest).exists());
        let progress = seen.lock().expect("progress log").clone();
        assert_eq!(progress.last().copied(), Some(body.len() as u64));
        assert!(
            progress.windows(2).all(|pair| pair[0] <= pair[1]),
            "{progress:?}"
        );
        assert!(
            progress.len() <= body.len() / 256 + 1,
            "progress must be throttled: {progress:?}"
        );
    }

    #[tokio::test]
    async fn rejects_a_declared_size_above_the_expected_size_before_writing() {
        let body = payload(2048);
        let server = serve(vec![Reply::Send(http_response(
            "200 OK",
            Some(body.len()),
            &body,
        ))]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let calls = AtomicUsize::new(0);
        let on_progress = |_: u64| {
            calls.fetch_add(1, Ordering::SeqCst);
        };

        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            1024,
            &test_options(),
            &on_progress,
        )
        .await
        .expect_err("an oversized declaration must be rejected");

        assert!(
            matches!(
                error,
                DownloadError::DeclaredSize {
                    expected: 1024,
                    declared: 2048
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains("超过预期"), "{error}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "nothing may be written or reported"
        );
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn aborts_a_stream_that_overflows_without_content_length() {
        let body = payload(4096);
        let server = serve(vec![Reply::Send(http_response("200 OK", None, &body))]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");

        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            1000,
            &test_options(),
            &|_: u64| {},
        )
        .await
        .expect_err("an overflowing stream must be aborted");

        assert!(
            matches!(error, DownloadError::TooLarge { expected: 1000 }),
            "{error:?}"
        );
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn rejects_bodies_shorter_than_the_expected_size() {
        let body = payload(500);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");

        // The server simply stops early on a close-delimited body.
        let server = serve(vec![Reply::Send(http_response("200 OK", None, &body))]);
        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            1000,
            &test_options(),
            &|_: u64| {},
        )
        .await
        .expect_err("a short body must be rejected");
        assert!(
            matches!(
                error,
                DownloadError::SizeMismatch {
                    expected: 1000,
                    actual: 500
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains("不完整"), "{error}");
        assert_nothing_left(&dest);

        // A smaller declared size is refused before any byte is written.
        let server = serve(vec![Reply::Send(http_response(
            "200 OK",
            Some(body.len()),
            &body,
        ))]);
        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            1000,
            &test_options(),
            &|_: u64| {},
        )
        .await
        .expect_err("a smaller declared size must be rejected");
        assert!(
            matches!(
                error,
                DownloadError::DeclaredSize {
                    expected: 1000,
                    declared: 500
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains("不符"), "{error}");
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn reports_http_errors_in_plain_text_and_clears_stale_partial_files() {
        for (status, code) in [
            ("404 Not Found", 404_u16),
            ("500 Internal Server Error", 500),
        ] {
            let server = serve(vec![Reply::Send(http_response(
                status,
                Some(7),
                b"missing",
            ))]);
            let dir = tempfile::tempdir().expect("tempdir");
            let dest = dir.path().join("package.bin");
            // A partial file left by an interrupted older run must go too.
            std::fs::write(partial_path(&dest), b"stale").expect("seed a stale partial file");

            let error = download_to_file(
                &loopback_client(),
                &server.url,
                &dest,
                7,
                &test_options(),
                &|_: u64| {},
            )
            .await
            .expect_err("an HTTP error status must fail the download");

            assert!(
                matches!(&error, DownloadError::HttpStatus(found) if found.as_u16() == code),
                "{error:?}"
            );
            let message = error.to_string();
            assert!(message.contains(&format!("HTTP {code}")), "{message}");
            assert!(message.starts_with("服务器返回"), "{message}");
            assert_nothing_left(&dest);
        }
    }

    #[tokio::test]
    async fn gives_up_when_the_connection_stalls() {
        let mut reply = http_response("200 OK", Some(1000), b"");
        reply.extend_from_slice(&payload(10));
        let server = serve(vec![Reply::SendThenStall(reply, Duration::from_secs(6))]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let options = DownloadOptions {
            stall_timeout: Duration::from_millis(400),
            ..test_options()
        };

        let started = Instant::now();
        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            1000,
            &options,
            &|_: u64| {},
        )
        .await
        .expect_err("a silent connection must time out");

        assert!(matches!(error, DownloadError::Stalled(_)), "{error:?}");
        assert!(error.to_string().contains("400 毫秒"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "stall detection must not wait for the server to close"
        );
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn retries_a_transport_failure_from_a_clean_start() {
        let body = payload(2048);
        let server = serve(vec![
            Reply::Hangup,
            Reply::Send(http_response("200 OK", Some(body.len()), &body)),
        ]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let options = DownloadOptions {
            max_retries: 2,
            ..test_options()
        };
        let seen = Mutex::new(Vec::new());
        let on_progress = |downloaded: u64| seen.lock().expect("progress log").push(downloaded);

        download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            body.len() as u64,
            &options,
            &on_progress,
        )
        .await
        .expect("the second attempt succeeds");

        assert_eq!(server.connections.load(Ordering::SeqCst), 2);
        assert_eq!(std::fs::read(&dest).expect("read download"), body);
        assert!(!partial_path(&dest).exists());
        let progress = seen.lock().expect("progress log").clone();
        assert_eq!(
            progress.first().copied(),
            Some(0),
            "a retry resets progress"
        );
        assert_eq!(progress.last().copied(), Some(body.len() as u64));
    }

    #[tokio::test]
    async fn stops_after_the_retry_budget_is_used() {
        let server = serve(vec![Reply::Hangup, Reply::Hangup]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let options = DownloadOptions {
            max_retries: 1,
            ..test_options()
        };

        let error = download_to_file(
            &loopback_client(),
            &server.url,
            &dest,
            100,
            &options,
            &|_: u64| {},
        )
        .await
        .expect_err("every attempt fails");

        assert!(
            matches!(&error, DownloadError::Retried { retries: 1, last }
                if matches!(**last, DownloadError::Transport { .. })),
            "{error:?}"
        );
        assert!(error.to_string().contains("已自动重试 1 次"), "{error}");
        assert_eq!(server.connections.load(Ordering::SeqCst), 2);
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn describes_refused_connections_in_chinese() {
        // Reserve a port, then free it so the connection is refused.
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a port");
        let address = listener.local_addr().expect("listener address");
        drop(listener);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");

        let error = download_to_file(
            &loopback_client(),
            &format!("http://{address}/payload.bin"),
            &dest,
            100,
            &test_options(),
            &|_: u64| {},
        )
        .await
        .expect_err("a refused connection fails");

        assert!(
            matches!(
                error,
                DownloadError::Transport {
                    retryable: true,
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(error.to_string().starts_with("无法连接到服务器"), "{error}");
        assert!(!error.to_string().contains("payload.bin"), "{error}");
        assert_nothing_left(&dest);
    }

    #[tokio::test]
    async fn refuses_plain_http_when_https_is_required() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let options = DownloadOptions {
            require_https: true,
            ..test_options()
        };

        let error = download_to_file(
            &loopback_client(),
            "http://127.0.0.1:9/payload.bin",
            &dest,
            10,
            &options,
            &|_: u64| {},
        )
        .await
        .expect_err("plain HTTP must be refused");

        assert!(matches!(error, DownloadError::InsecureUrl), "{error:?}");
        assert_nothing_left(&dest);
    }

    #[test]
    fn blocking_wrapper_drives_the_download_from_a_plain_thread() {
        let body = payload(1024);
        let server = serve(vec![Reply::Send(http_response(
            "200 OK",
            Some(body.len()),
            &body,
        ))]);
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("package.bin");
        let reported = Arc::new(AtomicUsize::new(0));
        let last = reported.clone();
        let on_progress: ProgressCallback = Arc::new(move |downloaded: u64| {
            last.store(downloaded as usize, Ordering::SeqCst);
        });

        // Runs on a plain test thread, like a `spawn_blocking` closure: the
        // download itself runs as a task on the shared runtime.
        download_to_file_blocking(
            loopback_client(),
            server.url.clone(),
            dest.clone(),
            body.len() as u64,
            test_options(),
            on_progress,
        )
        .expect("blocking download succeeds");

        assert_eq!(std::fs::read(&dest).expect("read download"), body);
        assert!(!partial_path(&dest).exists());
        assert_eq!(reported.load(Ordering::SeqCst), body.len());

        // Failures come back through the same channel. Reserve a port and
        // free it again so the connection is refused.
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a port");
        let address = listener.local_addr().expect("listener address");
        drop(listener);
        let error = download_to_file_blocking(
            loopback_client(),
            format!("https://{address}/never.bin"),
            dir.path().join("never.bin"),
            1,
            DownloadOptions {
                require_https: true,
                ..test_options()
            },
            Arc::new(|_: u64| {}),
        )
        .expect_err("an unreachable server fails");
        assert!(
            matches!(error, DownloadError::Transport { .. }),
            "{error:?}"
        );
        assert!(!dir.path().join("never.bin").exists());
    }
}
