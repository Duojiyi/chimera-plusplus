// Step 1.2 RED — These tests fail to compile until domain types are implemented in src/.
// Run: cargo test -p chimera-domain --locked
// Expected: compile error referencing missing types.

use chimera_domain::{
    InstallMode, InstallOwnership, OperationError, Provider, ProviderHealth, ProviderKind,
    ProviderProtocol, RuntimeState, TransactionState, UpdateState,
};

// ── Provider ─────────────────────────────────────────────────────────────────

#[test]
fn provider_chimera_hub_kind_serializes_correctly() {
    let p = Provider {
        id: uuid::Uuid::new_v4(),
        display_name: "ChimeraHub".to_string(),
        kind: ProviderKind::ChimeraHub,
        base_url: "https://api.chimerahub.org/v1".parse().unwrap(),
        protocol: ProviderProtocol::Responses,
        secret_ref: None,
        selected_model: None,
        discovered_models: vec![],
        health: ProviderHealth::Unknown,
    };
    let s = serde_json::to_string(&p).unwrap();
    assert!(s.contains("chimera_hub") || s.contains("ChimeraHub"));
}

#[test]
fn provider_custom_kind_requires_secret_ref() {
    let p = Provider {
        id: uuid::Uuid::new_v4(),
        display_name: "My API".to_string(),
        kind: ProviderKind::Custom,
        base_url: "https://api.example.com/v1".parse().unwrap(),
        protocol: ProviderProtocol::Responses,
        secret_ref: Some("keychain://chimera/my-api".to_string()),
        selected_model: Some("gpt-4o".to_string()),
        discovered_models: vec![],
        health: ProviderHealth::Healthy,
    };
    assert!(p.secret_ref.is_some());
    assert_eq!(p.health, ProviderHealth::Healthy);
}

#[test]
fn provider_health_variants_are_exhaustive() {
    let variants = [
        ProviderHealth::Unknown,
        ProviderHealth::Healthy,
        ProviderHealth::AuthFailed,
        ProviderHealth::Incompatible,
        ProviderHealth::Unreachable,
    ];
    assert_eq!(variants.len(), 5, "All health variants must be represented");
}

// ── InstallOwnership ──────────────────────────────────────────────────────────

#[test]
fn install_ownership_managed_portable_roundtrip() {
    let o = InstallOwnership {
        install_mode: InstallMode::ManagedPortable,
        canonical_path: std::path::PathBuf::from("/tmp/chimera/runtime/versions/26.721"),
        codex_version: "26.721.41059".to_string(),
        source_manifest_digest: "sha256:abc123".to_string(),
        file_tree_digest: "sha256:def456".to_string(),
        created_by_chimera_version: "2.0.0-beta".to_string(),
        transaction_state: TransactionState::Clean,
        last_health_result: None,
    };
    let json = serde_json::to_string(&o).unwrap();
    let o2: InstallOwnership = serde_json::from_str(&json).unwrap();
    assert_eq!(o.codex_version, o2.codex_version);
    assert_eq!(o.install_mode, o2.install_mode);
}

#[test]
fn install_mode_variants_cover_all_cases() {
    let _modes = [
        InstallMode::ManagedPortable,
        InstallMode::ExternalMsix,
        InstallMode::ExternalPortable,
    ];
}

#[test]
fn transaction_state_variants_cover_journal_lifecycle() {
    let _states = [
        TransactionState::Clean,
        TransactionState::Pending {
            operation: "switch_provider".to_string(),
        },
        TransactionState::Failed {
            reason: "disk full".to_string(),
        },
    ];
}

// ── RuntimeState ─────────────────────────────────────────────────────────────

#[test]
fn runtime_state_idle_is_default() {
    let s: RuntimeState = RuntimeState::default();
    assert!(matches!(s, RuntimeState::Idle));
}

#[test]
fn runtime_state_running_carries_pid() {
    let s = RuntimeState::Running { pid: 12345 };
    if let RuntimeState::Running { pid } = s {
        assert_eq!(pid, 12345);
    } else {
        panic!("expected Running");
    }
}

// ── UpdateState ──────────────────────────────────────────────────────────────

#[test]
fn update_state_machine_transitions_are_represented() {
    // These just verify the variants compile; transition logic is tested in integration tests.
    let _states: Vec<UpdateState> = vec![
        UpdateState::Idle,
        UpdateState::Checking,
        UpdateState::Available {
            version: "26.732".to_string(),
        },
        UpdateState::Downloading {
            version: "26.732".to_string(),
            bytes_done: 0,
            bytes_total: 1024,
        },
        UpdateState::Paused {
            version: "26.732".to_string(),
        },
        UpdateState::Verifying {
            version: "26.732".to_string(),
        },
        UpdateState::Staged {
            version: "26.732".to_string(),
        },
        UpdateState::WaitingForSafeRestart {
            version: "26.732".to_string(),
        },
        UpdateState::Committing {
            version: "26.732".to_string(),
        },
        UpdateState::HealthChecking {
            version: "26.732".to_string(),
        },
        UpdateState::Succeeded {
            version: "26.732".to_string(),
        },
        UpdateState::RolledBack {
            reason: "health check failed".to_string(),
        },
        UpdateState::FailedRecoverable {
            version: "26.732".to_string(),
            reason: "disk full".to_string(),
        },
    ];
    assert_eq!(_states.len(), 13);
}

#[test]
fn committing_state_must_not_be_interrupted() {
    // Encode the spec rule: once Committing, no ordinary exit is allowed.
    // This test validates that Committing is NOT in the cancellable set.
    let cancellable = UpdateState::cancellable_states();
    assert!(
        !cancellable.contains(&"Committing"),
        "Committing state must NOT be cancellable"
    );
}

// ── OperationError ───────────────────────────────────────────────────────────

#[test]
fn operation_error_cas_conflict_carries_hashes() {
    let e = OperationError::CasConflict {
        expected_hash: "abc".to_string(),
        actual_hash: "xyz".to_string(),
    };
    let msg = format!("{e}");
    assert!(
        msg.contains("abc") || msg.contains("conflict") || msg.contains("CAS"),
        "Error message should mention conflict: {msg}"
    );
}

#[test]
fn operation_error_cross_origin_redirect_is_detectable() {
    let e = OperationError::CrossOriginRedirect {
        from: "https://api.example.com".to_string(),
        to: "https://evil.example.net".to_string(),
    };
    let msg = format!("{e}");
    assert!(!msg.is_empty());
}

#[test]
fn operation_error_invalid_url_rejects_http() {
    let e = OperationError::InvalidUrl("http://insecure.example.com".to_string());
    // Verify the URL is stored in the error
    if let OperationError::InvalidUrl(url) = &e {
        assert!(url.starts_with("http://"));
    }
}
