use crate::database::Database;
use crate::services::{ProxyService, UsageCache};
use std::sync::Arc;

/// 全局应用状态
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub proxy_service: ProxyService,
    pub usage_cache: Arc<UsageCache>,
    pub(crate) cc_switch_preview:
        Arc<std::sync::Mutex<Option<crate::commands::CcSwitchPreviewSession>>>,
    /// Serializes an entire Profile application across UI, tray and deep links.
    pub profile_apply_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    /// 创建新的应用状态
    pub fn new(db: Arc<Database>) -> Self {
        let proxy_service = ProxyService::new(db.clone());

        Self {
            db,
            proxy_service,
            usage_cache: Arc::new(UsageCache::new()),
            cc_switch_preview: Arc::new(std::sync::Mutex::new(None)),
            profile_apply_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
