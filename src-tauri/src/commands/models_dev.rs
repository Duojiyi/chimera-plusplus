//! Pricing catalog from models.dev (with OpenRouter fallback for missing models),
//! fetched by the backend so requests use the app's outbound proxy and the renderer
//! needs no direct network access.

#[cfg(test)]
use crate::database::lock_conn;
use crate::database::Database;
use crate::services::usage_stats::{
    clean_model_id_for_pricing, find_model_pricing, is_placeholder_pricing_model,
};
use rust_decimal::Decimal;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";
const OPENROUTER_MODELS_API_URL: &str = "https://openrouter.ai/api/v1/models";
/// The full catalog is a few MiB; anything far beyond that is not the catalog.
const MODELS_DEV_MAX_BYTES: usize = 32 * 1024 * 1024;
/// Total request timeout covering headers + full body read (cross-border links can exceed 30s).
const MODELS_DEV_TIMEOUT: Duration = Duration::from_secs(60);
/// Cooldown between automatic online pricing lookups for unpriced models (matches CC Switch's 6h).
const AUTO_PRICING_SYNC_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);

const FIRST_PARTY_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "moonshotai",
    "moonshotai-cn",
    "alibaba",
    "alibaba-cn",
    "zhipuai",
    "zhipuai-coding-plan",
    "xai",
    "minimax",
    "minimax-cn",
    "stepfun",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogPricingEntry {
    model_id: String,
    display_name: String,
    input: String,
    output: String,
    cache_read: String,
    cache_creation: String,
    first_party: bool,
}

fn auto_sync_last_attempt() -> &'static Mutex<Option<Instant>> {
    static LAST_ATTEMPT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST_ATTEMPT.get_or_init(|| Mutex::new(None))
}

async fn fetch_json_catalog(url: &str, label: &str) -> Result<String, String> {
    let response = crate::proxy::http_client::get()
        .get(url)
        .timeout(MODELS_DEV_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{label} 请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{label} HTTP {}", status.as_u16()));
    }
    crate::services::model_fetch::read_response_text_limited(response, MODELS_DEV_MAX_BYTES, label)
        .await
}

/// The raw catalog JSON; the pricing picker parses and filters it.
#[tauri::command]
pub async fn fetch_models_dev_catalog() -> Result<String, String> {
    fetch_json_catalog(MODELS_DEV_API_URL, "models.dev catalog").await
}

fn format_non_negative_price(value: Decimal) -> Option<String> {
    if value.is_sign_negative() {
        return None;
    }
    let normalized = value.normalize();
    if normalized.is_zero() {
        return Some("0".to_string());
    }
    Some(normalized.to_string())
}

fn format_f64_price(value: Option<f64>) -> Option<String> {
    let v = value?;
    if !v.is_finite() || !(0.0..1e12).contains(&v) {
        return None;
    }
    let decimal = Decimal::from_str(&format!("{v:.6}")).ok()?;
    format_non_negative_price(decimal)
}

fn parse_models_dev_prices(
    raw_json: &str,
    needed: &HashSet<String>,
) -> HashMap<String, CatalogPricingEntry> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw_json) else {
        return HashMap::new();
    };
    let mut matched: HashMap<String, CatalogPricingEntry> = HashMap::new();

    for (provider_id, provider_val) in root {
        let Some(models) = provider_val.get("models").and_then(Value::as_object) else {
            continue;
        };
        let is_first_party = FIRST_PARTY_PROVIDERS
            .iter()
            .any(|p| p.eq_ignore_ascii_case(&provider_id));

        for (raw_model_id, model_val) in models {
            let normalized = clean_model_id_for_pricing(raw_model_id);
            if !needed.contains(&normalized) {
                continue;
            }
            let Some(cost) = model_val.get("cost").and_then(Value::as_object) else {
                continue;
            };
            let input_opt = cost.get("input").and_then(Value::as_f64);
            let output_opt = cost.get("output").and_then(Value::as_f64);
            if input_opt.is_none() && output_opt.is_none() {
                continue;
            }
            let Some(input) = format_f64_price(Some(input_opt.unwrap_or(0.0))) else {
                continue;
            };
            let Some(output) = format_f64_price(Some(output_opt.unwrap_or(0.0))) else {
                continue;
            };
            if input == "0" && output == "0" {
                continue;
            }
            let cache_read = format_f64_price(cost.get("cache_read").and_then(Value::as_f64))
                .unwrap_or_else(|| "0".to_string());
            let cache_creation = format_f64_price(cost.get("cache_write").and_then(Value::as_f64))
                .unwrap_or_else(|| "0".to_string());
            let display_name = model_val
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(raw_model_id)
                .to_string();

            let should_replace = match matched.get(&normalized) {
                None => true,
                Some(existing) => !existing.first_party && is_first_party,
            };
            if should_replace {
                matched.insert(
                    normalized.clone(),
                    CatalogPricingEntry {
                        model_id: normalized,
                        display_name,
                        input,
                        output,
                        cache_read,
                        cache_creation,
                        first_party: is_first_party,
                    },
                );
            }
        }
    }

    matched
}

fn parse_openrouter_per_token_to_per_million(val: Option<&Value>) -> Option<String> {
    let raw = match val? {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let per_token = Decimal::from_str(&raw).ok()?;
    if per_token.is_sign_negative() {
        return None;
    }
    let per_million = per_token.checked_mul(Decimal::from(1_000_000u64))?;
    format_non_negative_price(per_million)
}

fn parse_openrouter_prices(
    raw_json: &str,
    needed: &HashSet<String>,
) -> HashMap<String, CatalogPricingEntry> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw_json) else {
        return HashMap::new();
    };
    let Some(data) = root.get("data").and_then(Value::as_array) else {
        return HashMap::new();
    };
    let mut matched: HashMap<String, CatalogPricingEntry> = HashMap::new();

    for item in data {
        let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        // Skip variant suffixes like `:free`, `:batch`, `:extended` so discounted or free tiers
        // never override standard pricing for the base model id.
        if raw_id.contains(':') {
            continue;
        }
        let normalized = clean_model_id_for_pricing(raw_id);
        if !needed.contains(&normalized) || matched.contains_key(&normalized) {
            continue;
        }
        let Some(pricing) = item.get("pricing").and_then(Value::as_object) else {
            continue;
        };
        let Some(input) = parse_openrouter_per_token_to_per_million(pricing.get("prompt")) else {
            continue;
        };
        let Some(output) = parse_openrouter_per_token_to_per_million(pricing.get("completion"))
        else {
            continue;
        };
        if input == "0" && output == "0" {
            continue;
        }
        let cache_read = parse_openrouter_per_token_to_per_million(pricing.get("input_cache_read"))
            .unwrap_or_else(|| "0".to_string());
        let cache_creation =
            parse_openrouter_per_token_to_per_million(pricing.get("input_cache_write"))
                .unwrap_or_else(|| "0".to_string());
        let display_name = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(raw_id)
            .to_string();

        matched.insert(
            normalized.clone(),
            CatalogPricingEntry {
                model_id: normalized,
                display_name,
                input,
                output,
                cache_read,
                cache_creation,
                first_party: false,
            },
        );
    }

    matched
}

fn find_unpriced_models_in_db(db: &Database) -> HashSet<String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT COALESCE(NULLIF(pricing_model, ''), model)
                 FROM proxy_request_logs
                 WHERE CAST(total_cost_usd AS REAL) <= 0
                   AND (input_tokens > 0 OR output_tokens > 0
                        OR cache_read_tokens > 0 OR cache_creation_tokens > 0)",
            )
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| crate::error::AppError::Database(e.to_string()))?;

        let mut missing = HashSet::new();
        for model in rows.flatten() {
            if is_placeholder_pricing_model(&model) {
                continue;
            }
            if find_model_pricing(conn, &model).is_some() {
                continue;
            }
            let normalized = clean_model_id_for_pricing(&model);
            if !normalized.is_empty() {
                missing.insert(normalized);
            }
        }
        Ok(missing)
    })
    .unwrap_or_default()
}

fn persist_discovered_prices_and_backfill(
    db: &Database,
    entries: &[CatalogPricingEntry],
) -> Result<usize, crate::error::AppError> {
    if entries.is_empty() {
        return Ok(0);
    }
    let inserted = db.with_conn(|conn| {
        let mut count = 0usize;
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO model_pricing (
                model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for entry in entries {
            count += stmt.execute(rusqlite::params![
                entry.model_id,
                entry.display_name,
                entry.input,
                entry.output,
                entry.cache_read,
                entry.cache_creation,
            ])?;
        }
        Ok(count)
    })?;

    if inserted > 0 {
        match db.backfill_missing_usage_costs() {
            Ok(updated) if updated > 0 => {
                crate::usage_events::notify_log_recorded();
                log::info!(
                    "[pricing-sync] 自动补齐 {inserted} 个模型定价并回填 {updated} 条历史用量成本"
                );
            }
            Ok(_) => {
                log::info!("[pricing-sync] 自动补齐 {inserted} 个模型定价");
            }
            Err(error) => {
                log::warn!("[pricing-sync] 补齐定价后回填历史用量成本失败: {error}");
            }
        }
    }
    Ok(inserted)
}

/// Automatically discover pricing for any unpriced models present in `proxy_request_logs`:
/// queries `models.dev` first, then falls back to OpenRouter for any remaining models.
/// Zero network requests are made if all logged models already have pricing; throttled to 6h.
pub(crate) async fn sync_missing_model_pricing_if_needed(db: Arc<Database>) {
    let missing = find_unpriced_models_in_db(&db);
    if missing.is_empty() {
        return;
    }

    {
        let mut last = auto_sync_last_attempt()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(prev) = *last {
            if prev.elapsed() < AUTO_PRICING_SYNC_COOLDOWN {
                return;
            }
        }
        *last = Some(Instant::now());
    }

    let mut remaining = missing.clone();
    let mut discovered: Vec<CatalogPricingEntry> = Vec::new();

    match fetch_json_catalog(MODELS_DEV_API_URL, "models.dev catalog").await {
        Ok(raw) => {
            let found = parse_models_dev_prices(&raw, &remaining);
            for (id, entry) in found {
                remaining.remove(&id);
                discovered.push(entry);
            }
        }
        Err(error) => {
            log::warn!("[pricing-sync] models.dev 查询失败，尝试 OpenRouter 兜底: {error}");
        }
    }

    if !remaining.is_empty() {
        match fetch_json_catalog(OPENROUTER_MODELS_API_URL, "OpenRouter models").await {
            Ok(raw) => {
                let found = parse_openrouter_prices(&raw, &remaining);
                for (id, entry) in found {
                    remaining.remove(&id);
                    discovered.push(entry);
                }
            }
            Err(error) => {
                log::warn!("[pricing-sync] OpenRouter 兜底查询失败: {error}");
            }
        }
    }

    if !discovered.is_empty() {
        if let Err(error) = persist_discovered_prices_and_backfill(&db, &discovered) {
            log::warn!("[pricing-sync] 保存自动获取的模型定价失败: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_dev_prefers_first_party_provider_over_aggregator() {
        let json = r#"{
            "openrouter": {
                "models": {
                    "openai/gpt-6.3-sol": {
                        "name": "OR GPT-6.3 Sol",
                        "cost": { "input": 2.5, "output": 12.5, "cache_read": 0.25, "cache_write": 3.0 }
                    }
                }
            },
            "openai": {
                "models": {
                    "gpt-6.3-sol": {
                        "name": "GPT-6.3 Sol",
                        "cost": { "input": 2, "output": 10, "cache_read": 0.1, "cache_write": 2.5 }
                    }
                }
            }
        }"#;
        let needed: HashSet<String> = ["gpt-6.3-sol".to_string()].into_iter().collect();
        let found = parse_models_dev_prices(json, &needed);
        let entry = found.get("gpt-6.3-sol").expect("found");
        assert_eq!(entry.display_name, "GPT-6.3 Sol");
        assert_eq!(entry.input, "2");
        assert_eq!(entry.output, "10");
        assert_eq!(entry.cache_read, "0.1");
        assert_eq!(entry.cache_creation, "2.5");
    }

    #[test]
    fn openrouter_converts_per_token_to_per_million_and_skips_variants() {
        let json = r#"{
            "data": [
                {
                    "id": "openai/gpt-6.3-astra:free",
                    "name": "GPT-6.3 Astra Free",
                    "pricing": { "prompt": "0", "completion": "0" }
                },
                {
                    "id": "openai/gpt-6.3-astra:batch",
                    "name": "GPT-6.3 Astra Batch",
                    "pricing": { "prompt": "0.000004", "completion": "0.00002" }
                },
                {
                    "id": "openai/gpt-6.3-astra",
                    "name": "OpenAI: GPT-6.3 Astra",
                    "pricing": {
                        "prompt": "0.000008",
                        "completion": "0.00004",
                        "input_cache_read": "0.0000004",
                        "input_cache_write": "0.00001"
                    }
                },
                {
                    "id": "custom/variable-model",
                    "name": "Variable",
                    "pricing": { "prompt": "-1", "completion": "-1" }
                }
            ]
        }"#;
        let needed: HashSet<String> = ["gpt-6.3-astra".to_string(), "variable-model".to_string()]
            .into_iter()
            .collect();
        let found = parse_openrouter_prices(json, &needed);
        assert!(!found.contains_key("variable-model"));
        let entry = found.get("gpt-6.3-astra").expect("found");
        assert_eq!(entry.input, "8");
        assert_eq!(entry.output, "40");
        assert_eq!(entry.cache_read, "0.4");
        assert_eq!(entry.cache_creation, "10");
    }

    #[test]
    fn persist_discovered_prices_backfills_zero_cost_logs() -> Result<(), crate::error::AppError> {
        let db = Database::memory().expect("memory db");
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO proxy_request_logs (
                    request_id, provider_id, app_type, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, input_cost_usd, output_cost_usd,
                    cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd, latency_ms,
                    status_code, created_at, data_source
                ) VALUES (
                    'req-novel-1', '_codex_session', 'codex', 'gpt-6.9-novel', 1000000, 100000,
                    0, 0, '0', '0', '0', '0', '0', 0, 200, 1795450000, 'codex_session'
                )",
                [],
            )
            .expect("insert log");
        }

        let missing = find_unpriced_models_in_db(&db);
        assert!(missing.contains("gpt-6.9-novel"));

        let inserted = persist_discovered_prices_and_backfill(
            &db,
            &[CatalogPricingEntry {
                model_id: "gpt-6.9-novel".to_string(),
                display_name: "GPT-6.9 Novel".to_string(),
                input: "2".to_string(),
                output: "10".to_string(),
                cache_read: "0.1".to_string(),
                cache_creation: "2.5".to_string(),
                first_party: true,
            }],
        )
        .expect("persist");
        assert_eq!(inserted, 1);

        let detail = db
            .get_request_detail("req-novel-1")
            .expect("query")
            .expect("row");
        assert_eq!(detail.total_cost_usd, "3.000000");
        assert!(find_unpriced_models_in_db(&db).is_empty());
        Ok(())
    }
}
