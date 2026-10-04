use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

/// 供应商种类：ChimeraHub（唯一内置模板）或自定义。
/// Official 是独立系统模式，不作为 Provider 存在。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    ChimeraHub,
    Custom,
}

/// 供应商协议：v2.0.0 只承诺 OpenAI Responses API。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    Responses,
}

/// 供应商健康状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealth {
    #[default]
    Unknown,
    Healthy,
    AuthFailed,
    Incompatible,
    Unreachable,
}

/// 已发现的模型条目（缓存，不是 Key）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredModel {
    pub id: String,
    pub display_name: Option<String>,
}

/// 供应商实体。
/// `secret_ref` 是 OS keychain 引用字符串，不是 Key 本身。
/// Key 永远不进此结构体、不进 SQLite、不进日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: Uuid,
    pub display_name: String,
    pub kind: ProviderKind,
    #[serde(with = "url_serde")]
    pub base_url: Url,
    pub protocol: ProviderProtocol,
    /// OS keychain reference, e.g. "keychain://chimera/<name>". None for Official mode.
    pub secret_ref: Option<String>,
    pub selected_model: Option<String>,
    #[serde(default)]
    pub discovered_models: Vec<DiscoveredModel>,
    pub health: ProviderHealth,
}

/// serde helper for Url — serialize as string.
mod url_serde {
    use serde::{Deserialize, Deserializer, Serializer};
    use url::Url;
    pub fn serialize<S: Serializer>(url: &Url, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(url.as_str())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Url, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<Url>().map_err(serde::de::Error::custom)
    }
}
