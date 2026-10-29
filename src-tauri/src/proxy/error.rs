use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("服务器已在运行")]
    AlreadyRunning,

    #[error("服务器未运行")]
    NotRunning,

    #[error("地址绑定失败: {0}")]
    BindFailed(String),

    #[error("停止超时")]
    StopTimeout,

    #[error("停止失败: {0}")]
    StopFailed(String),

    #[error("请求转发失败: {0}")]
    ForwardFailed(String),

    #[error("无可用的Provider")]
    NoAvailableProvider,

    #[error("所有供应商已熔断，无可用渠道")]
    AllProvidersCircuitOpen,

    #[error("未配置供应商")]
    NoProvidersConfigured,

    #[allow(dead_code)]
    #[error("Provider不健康: {0}")]
    ProviderUnhealthy(String),

    #[error("上游错误 (状态码 {status}): {body:?}")]
    UpstreamError { status: u16, body: Option<String> },

    #[error("超过最大重试次数")]
    MaxRetriesExceeded,

    #[error("数据库错误: {0}")]
    DatabaseError(String),

    #[error("配置错误: {0}")]
    ConfigError(String),

    #[allow(dead_code)]
    #[error("格式转换错误: {0}")]
    TransformError(String),

    #[allow(dead_code)]
    #[error("无效的请求: {0}")]
    InvalidRequest(String),

    #[error("超时: {0}")]
    Timeout(String),

    /// 流式响应空闲超时
    #[allow(dead_code)]
    #[error("流式响应空闲超时: {0}秒无数据")]
    StreamIdleTimeout(u64),

    /// 认证错误
    #[error("认证失败: {0}")]
    AuthError(String),

    #[allow(dead_code)]
    #[error("内部错误: {0}")]
    Internal(String),
}

/// Gemini（含其 OpenAI 兼容端点）把错误体包成单元素数组
/// `[{"error": {...}}]`，客户端按对象解析会拿不到 `error`。只解开
/// "恰好一个元素且该元素带 `error` 对象" 的形态，其它 JSON 原样返回。
// Adapted from BigPizzaV3/CodexPlusPlus a318d2fb
pub(crate) fn unwrap_error_array_body(value: &serde_json::Value) -> &serde_json::Value {
    match value.as_array().map(Vec::as_slice) {
        Some([first]) if first.get("error").is_some_and(serde_json::Value::is_object) => first,
        _ => value,
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            ProxyError::UpstreamError {
                status: upstream_status,
                body: upstream_body,
            } => {
                let http_status =
                    StatusCode::from_u16(*upstream_status).unwrap_or(StatusCode::BAD_GATEWAY);

                // 尝试解析上游响应体为 JSON，如果失败则包装为字符串
                let error_body = if let Some(body_str) = upstream_body {
                    if let Ok(json_body) = serde_json::from_str::<serde_json::Value>(body_str) {
                        // 上游返回的是 JSON，直接透传（Gemini 的单元素数组错误体先解包）
                        unwrap_error_array_body(&json_body).clone()
                    } else {
                        // 上游返回的不是 JSON，包装为错误消息
                        json!({
                            "error": {
                                "message": body_str,
                                "type": "upstream_error",
                            }
                        })
                    }
                } else {
                    json!({
                        "error": {
                            "message": format!("Upstream error (status {})", upstream_status),
                            "type": "upstream_error",
                        }
                    })
                };

                (http_status, error_body)
            }
            _ => {
                let (http_status, message) = match &self {
                    ProxyError::AlreadyRunning => (StatusCode::CONFLICT, self.to_string()),
                    ProxyError::NotRunning => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
                    ProxyError::BindFailed(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::StopTimeout => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::StopFailed(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::ForwardFailed(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
                    ProxyError::NoAvailableProvider => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::AllProvidersCircuitOpen => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::NoProvidersConfigured => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::ProviderUnhealthy(_) => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::MaxRetriesExceeded => {
                        (StatusCode::SERVICE_UNAVAILABLE, self.to_string())
                    }
                    ProxyError::DatabaseError(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::ConfigError(_) => (StatusCode::BAD_REQUEST, self.to_string()),
                    ProxyError::TransformError(_) => {
                        (StatusCode::UNPROCESSABLE_ENTITY, self.to_string())
                    }
                    ProxyError::InvalidRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
                    ProxyError::Timeout(_) => (StatusCode::GATEWAY_TIMEOUT, self.to_string()),
                    ProxyError::StreamIdleTimeout(_) => {
                        (StatusCode::GATEWAY_TIMEOUT, self.to_string())
                    }
                    ProxyError::AuthError(_) => (StatusCode::UNAUTHORIZED, self.to_string()),
                    ProxyError::Internal(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                    }
                    ProxyError::UpstreamError { .. } => unreachable!(),
                };

                let error_body = json!({
                    "error": {
                        "message": message,
                        "type": "proxy_error",
                    }
                });

                (http_status, error_body)
            }
        };

        (status, Json(body)).into_response()
    }
}

/// 错误分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// 可重试错误（网络问题、5xx）
    Retryable, // 网络超时、5xx 错误
    /// 不可重试错误（4xx、认证失败）
    NonRetryable, // 认证失败、参数错误、4xx 错误
    #[allow(dead_code)]
    ClientAbort, // 客户端主动中断
}

/// 判断错误是否可重试
#[allow(dead_code)]
pub fn categorize_error(error: &reqwest::Error) -> ErrorCategory {
    if error.is_timeout() || error.is_connect() {
        return ErrorCategory::Retryable;
    }

    if let Some(status) = error.status() {
        if status.is_server_error() {
            ErrorCategory::Retryable
        } else if status.is_client_error() {
            ErrorCategory::NonRetryable
        } else {
            ErrorCategory::Retryable
        }
    } else {
        ErrorCategory::Retryable
    }
}

/// 沿 `source()` 链把错误原因用 `: ` 拼接，相邻重复的片段只保留一次。
// Adapted from farion1231/cc-switch 0d326a4c
pub fn describe_error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(err) = current {
        let text = err.to_string();
        if !text.is_empty() && parts.last() != Some(&text) {
            parts.push(text);
        }
        current = err.source();
    }
    parts.join(": ")
}

/// 描述 reqwest 错误：先去掉 URL（可能带 `?key=` 等凭据），再展开原因链。
pub fn describe_reqwest_error(error: reqwest::Error) -> String {
    describe_error_chain(&error.without_url())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    #[test]
    fn single_element_error_array_is_unwrapped_only_in_exact_shape() {
        let gemini =
            json!([{"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}}]);
        assert_eq!(unwrap_error_array_body(&gemini), &gemini[0]);
        for other in [
            json!([{"error": {"message": "a"}}, {"error": {"message": "b"}}]),
            json!([{"error": "text"}]),
            json!([]),
            json!({"error": {"message": "object"}}),
        ] {
            assert_eq!(unwrap_error_array_body(&other), &other);
        }
    }

    #[derive(Debug)]
    struct Layer {
        message: &'static str,
        inner: Option<Box<Layer>>,
    }

    impl fmt::Display for Layer {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.message)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.inner
                .as_deref()
                .map(|inner| inner as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn error_chain_includes_innermost_cause() {
        let err = Layer {
            message: "client error (Connect)",
            inner: Some(Box::new(Layer {
                message: "tcp connect error",
                inner: Some(Box::new(Layer {
                    message: "Connection refused (os error 111)",
                    inner: None,
                })),
            })),
        };
        assert_eq!(
            describe_error_chain(&err),
            "client error (Connect): tcp connect error: Connection refused (os error 111)"
        );
    }

    #[test]
    fn error_chain_dedups_adjacent_repeats() {
        let err = Layer {
            message: "same",
            inner: Some(Box::new(Layer {
                message: "same",
                inner: Some(Box::new(Layer {
                    message: "different",
                    inner: None,
                })),
            })),
        };
        assert_eq!(describe_error_chain(&err), "same: different");
    }

    #[tokio::test]
    async fn reqwest_error_description_drops_url_secrets() {
        let err = reqwest::Client::new()
            .get("http://127.0.0.1:1/v1/models?key=SECRET-TOKEN")
            .send()
            .await
            .expect_err("port 1 should refuse the connection");
        let text = describe_reqwest_error(err);
        assert!(!text.contains("SECRET-TOKEN"), "{text}");
        assert!(!text.contains("127.0.0.1:1/v1"), "{text}");
    }
}
