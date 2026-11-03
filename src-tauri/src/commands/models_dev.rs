//! Pricing catalog from models.dev, fetched by the backend so the request uses
//! the app's outbound proxy and the renderer needs no direct network access.

use std::time::Duration;

const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";
/// The full catalog is a few MiB; anything far beyond that is not the catalog.
const MODELS_DEV_MAX_BYTES: usize = 16 * 1024 * 1024;
const MODELS_DEV_TIMEOUT: Duration = Duration::from_secs(30);

/// The raw catalog JSON; the pricing picker parses and filters it.
#[tauri::command]
pub async fn fetch_models_dev_catalog() -> Result<String, String> {
    let response = crate::proxy::http_client::get()
        .get(MODELS_DEV_API_URL)
        .timeout(MODELS_DEV_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("models.dev 请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    crate::services::model_fetch::read_response_text_limited(
        response,
        MODELS_DEV_MAX_BYTES,
        "models.dev catalog",
    )
    .await
}
