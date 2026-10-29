//! 拒绝把请求转发回本代理自己的监听地址，避免请求环（无限自转发、内存暴涨）。
//!
//! Adapted from farion1231/cc-switch cd9c7210

use super::ProxyError;
use std::net::IpAddr;

/// 发送前检查最终上游 URL 是否指向本代理的监听地址（`listen_address:listen_port`）。
///
/// - 端口不同或代理未在监听（端口 0）时直接放行，不做 DNS 解析，普通上游不受影响；
/// - `localhost` / `*.localhost` 视为回环；其它主机名只在端口相同时才解析；
/// - 错误信息里不带 URL：线路地址的路径或查询串可能含 API Key。
pub(super) async fn reject_self_forwarding(
    target: &str,
    listen_address: &str,
    listen_port: u16,
) -> Result<(), ProxyError> {
    if listen_port == 0 {
        return Ok(());
    }
    let Ok(url) = url::Url::parse(target) else {
        return Ok(());
    };
    if url.port_or_known_default() != Some(listen_port) {
        return Ok(());
    }
    let Ok(listener) = listen_address.trim_matches(['[', ']']).parse::<IpAddr>() else {
        return Ok(());
    };
    let targets_listener = match url.host() {
        Some(url::Host::Ipv4(ip)) => is_listener_address(ip.into(), listener),
        Some(url::Host::Ipv6(ip)) => is_listener_address(ip.into(), listener),
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if host == "localhost" || host.ends_with(".localhost") {
                is_listener_address(std::net::Ipv4Addr::LOCALHOST.into(), listener)
                    || is_listener_address(std::net::Ipv6Addr::LOCALHOST.into(), listener)
            } else {
                tokio::net::lookup_host((host.as_str(), listen_port))
                    .await
                    .is_ok_and(|mut addresses| {
                        addresses.any(|address| is_listener_address(address.ip(), listener))
                    })
            }
        }
        None => false,
    };
    if targets_listener {
        return Err(ProxyError::ConfigError(
            "上游地址指向了本应用自己的本地代理，会造成请求循环；请把线路的接口地址改成真实的上游服务地址"
                .to_string(),
        ));
    }
    Ok(())
}

/// 目标 IP 是否会连到监听地址。本代理只允许绑定回环地址（见 `server.rs` 的
/// loopback 校验），所以这里不处理通配监听；`0.0.0.0` / `::` 作为目标时在多数
/// 系统上会连到本机，按命中处理。
fn is_listener_address(target: IpAddr, listener: IpAddr) -> bool {
    fn normalize(ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            ip => ip,
        }
    }
    let target = normalize(target);
    let listener = normalize(listener);
    if target == listener {
        return true;
    }
    target.is_unspecified() && listener.is_loopback() && target.is_ipv4() == listener.is_ipv4()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_urls_that_target_own_listener() {
        for (target, address, port) in [
            ("http://127.0.0.1:3688/v1/responses", "127.0.0.1", 3688),
            ("http://localhost:15721/v1", "127.0.0.1", 15721),
            ("http://LOCALHOST.:15721/v1", "127.0.0.1", 15721),
            ("http://proxy.localhost:15721/v1", "127.0.0.1", 15721),
            ("http://127.1:15721/v1", "127.0.0.1", 15721),
            ("http://[::ffff:127.0.0.1]:15721/v1", "127.0.0.1", 15721),
            ("http://[::1]:15721/v1", "::1", 15721),
            ("http://localhost:15721/v1", "::1", 15721),
            ("http://0.0.0.0:15721/v1", "127.0.0.1", 15721),
            ("http://127.0.0.1/v1", "127.0.0.1", 80),
        ] {
            assert!(
                matches!(
                    reject_self_forwarding(target, address, port).await,
                    Err(ProxyError::ConfigError(_))
                ),
                "{target} via {address}:{port}",
            );
        }
    }

    #[tokio::test]
    async fn allows_other_local_services_and_keeps_secrets_out_of_error() {
        for target in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://[::1]:11434/v1",
            "http://[::1]:15721/v1",
            "http://127.0.0.2:15721/v1",
            "https://api.example.com/v1",
            "not a url",
        ] {
            assert!(
                reject_self_forwarding(target, "127.0.0.1", 15721)
                    .await
                    .is_ok(),
                "{target}"
            );
        }
        // 代理未在监听（端口 0）时不拦截。
        assert!(
            reject_self_forwarding("http://localhost:15721/v1", "127.0.0.1", 0)
                .await
                .is_ok()
        );
        let error = reject_self_forwarding(
            "http://user:secret@127.0.0.1:15721/private-key/v1?key=private-token",
            "127.0.0.1",
            15721,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("本地代理"), "{error}");
        for secret in ["secret", "private-key", "private-token"] {
            assert!(!error.contains(secret), "{error}");
        }
    }
}
