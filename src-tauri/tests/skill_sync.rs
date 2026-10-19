use std::fs;

use chimera_plus_plus_lib::{
    migrate_skills_to_ssot, AppType, ImportSkillSelection, InstalledSkill, SkillApps, SkillService,
};

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

fn write_skill(dir: &std::path::Path, name: &str) {
    fs::create_dir_all(dir).expect("create skill dir");
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Test skill\n---\n"),
    )
    .expect("write SKILL.md");
}

#[cfg(unix)]
fn symlink_dir(src: &std::path::Path, dest: &std::path::Path) {
    std::os::unix::fs::symlink(src, dest).expect("create symlink");
}

#[cfg(windows)]
fn symlink_dir(src: &std::path::Path, dest: &std::path::Path) {
    std::os::windows::fs::symlink_dir(src, dest).expect("create symlink");
}

#[test]
fn import_from_apps_respects_explicit_app_selection() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    write_skill(
        &home.join(".claude").join("skills").join("shared-skill"),
        "Shared",
    );

    let state = create_test_state().expect("create test state");

    let imported = SkillService::import_from_apps(
        &state.db,
        vec![ImportSkillSelection {
            source_path: None,
            content_hash: None,
            directory: "shared-skill".to_string(),
            apps: SkillApps {
                opencode: true,
                ..Default::default()
            },
        }],
    )
    .expect("import skills");

    assert_eq!(imported.len(), 1, "expected exactly one imported skill");
    let skill = imported.first().expect("imported skill");
    assert!(
        skill.apps.opencode,
        "explicitly selected OpenCode app should remain enabled"
    );
    assert!(
        !skill.apps.claude && !skill.apps.codex && !skill.apps.gemini,
        "import should no longer infer apps from every matching source path"
    );
}

#[test]
fn import_from_apps_creates_missing_selected_projection_and_rolls_back_failed_batch() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    let source = home.join(".claude").join("skills").join("new-target");
    write_skill(&source, "New Target");
    let broken = home.join(".claude").join("skills").join("broken-target");
    write_skill(&broken, "Broken Target");
    fs::write(broken.join("SKILL.md"), "---\nname: [invalid]\n---\n").unwrap();
    let state = create_test_state().unwrap();
    let selection = |directory: &str| ImportSkillSelection {
        source_path: None,
        content_hash: None,
        directory: directory.to_string(),
        apps: SkillApps {
            codex: true,
            ..Default::default()
        },
    };
    let target = home.join(".codex").join("skills").join("new-target");
    let ssot = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills");
    assert!(SkillService::import_from_apps(
        &state.db,
        vec![selection("new-target"), selection("broken-target")]
    )
    .is_err());
    assert!(state.db.get_all_installed_skills().unwrap().is_empty());
    assert!(fs::symlink_metadata(&target).is_err());
    assert!(!ssot.join("new-target").exists());
    assert!(!ssot.join("broken-target").exists());
    let imported =
        SkillService::import_from_apps(&state.db, vec![selection("new-target")]).unwrap();
    assert!(imported[0].apps.codex);
    assert_eq!(
        fs::read(target.join("SKILL.md")).unwrap(),
        fs::read(source.join("SKILL.md")).unwrap()
    );
}

#[test]
fn import_from_apps_does_not_rewrite_selected_app_directory() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let codex_skill_dir = home.join(".codex").join("skills").join("codex-skill");
    write_skill(&codex_skill_dir, "Live Codex Skill");
    fs::write(codex_skill_dir.join("prompt.md"), "live codex").expect("write live codex prompt");

    let state = create_test_state().expect("create test state");

    let imported = SkillService::import_from_apps(
        &state.db,
        vec![ImportSkillSelection {
            source_path: None,
            content_hash: None,
            directory: "codex-skill".to_string(),
            apps: SkillApps {
                codex: true,
                ..Default::default()
            },
        }],
    )
    .expect("import skills");

    assert_eq!(imported.len(), 1, "expected exactly one imported skill");
    assert!(
        imported[0].apps.codex,
        "import should preserve the selected Codex app state"
    );
    assert_eq!(
        fs::read_to_string(codex_skill_dir.join("prompt.md")).expect("read live codex prompt"),
        "live codex",
        "import should not replace the app skill directory with SSOT contents"
    );
    assert!(
        !fs::symlink_metadata(&codex_skill_dir)
            .expect("read codex skill metadata")
            .file_type()
            .is_symlink(),
        "import should not replace the app skill directory with a managed symlink"
    );
}

#[test]
fn import_from_apps_rejects_stale_ssot_without_rewriting_either_source() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    let ssot = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills/codex-skill");
    let live = home.join(".codex/skills/codex-skill");
    write_skill(&ssot, "Stale SSOT Skill");
    write_skill(&live, "Live Codex Skill");
    let original_ssot = fs::read(ssot.join("SKILL.md")).unwrap();
    let original_live = fs::read(live.join("SKILL.md")).unwrap();
    let state = create_test_state().unwrap();

    let snapshot = SkillService::scan_unmanaged_scoped(&state.db, Some(AppType::Codex))
        .unwrap()
        .into_iter()
        .find(|row| row.directory == "codex-skill")
        .expect("live Codex source");
    assert_eq!(
        snapshot.path,
        live.canonicalize().unwrap().display().to_string()
    );
    let error = SkillService::import_from_apps(
        &state.db,
        vec![ImportSkillSelection {
            source_path: Some(snapshot.path),
            content_hash: Some(snapshot.content_hash),
            directory: "codex-skill".to_string(),
            apps: SkillApps {
                codex: true,
                ..Default::default()
            },
        }],
    )
    .unwrap_err();

    assert!(
        error.to_string().contains("共享目录内容与所选来源不同"),
        "{error:#}"
    );
    assert!(state.db.get_all_installed_skills().unwrap().is_empty());
    assert_eq!(fs::read(ssot.join("SKILL.md")).unwrap(), original_ssot);
    assert_eq!(fs::read(live.join("SKILL.md")).unwrap(), original_live);
}

#[test]
fn sync_to_app_removes_disabled_and_orphaned_ssot_symlinks() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let ssot_dir = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills");
    let disabled_skill = ssot_dir.join("disabled-skill");
    let orphan_skill = ssot_dir.join("orphan-skill");
    write_skill(&disabled_skill, "Disabled");
    write_skill(&orphan_skill, "Orphan");

    let opencode_skills_dir = home.join(".config").join("opencode").join("skills");
    fs::create_dir_all(&opencode_skills_dir).expect("create opencode skills dir");
    symlink_dir(&disabled_skill, &opencode_skills_dir.join("disabled-skill"));
    symlink_dir(&orphan_skill, &opencode_skills_dir.join("orphan-skill"));

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_skill(&InstalledSkill {
            id: "local:disabled-skill".to_string(),
            name: "Disabled".to_string(),
            description: None,
            directory: "disabled-skill".to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps::default(),
            installed_at: 0,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save disabled skill");

    SkillService::sync_to_app(&state.db, &AppType::OpenCode).expect("reconcile skills");

    assert!(
        !opencode_skills_dir.join("disabled-skill").exists(),
        "DB-known disabled skill should be removed from OpenCode live dir"
    );
    assert!(
        !opencode_skills_dir.join("orphan-skill").exists(),
        "orphaned symlink into SSOT should be cleaned up"
    );
}

#[test]
fn uninstall_skill_creates_backup_before_removing_ssot() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let ssot_skill_dir = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills")
        .join("backup-skill");
    write_skill(&ssot_skill_dir, "Backup Skill");
    fs::write(ssot_skill_dir.join("prompt.md"), "backup me").expect("write prompt.md");

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_skill(&InstalledSkill {
            id: "local:backup-skill".to_string(),
            name: "Backup Skill".to_string(),
            description: Some("Back me up before uninstall".to_string()),
            directory: "backup-skill".to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps {
                claude: true,
                ..Default::default()
            },
            installed_at: 123,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save skill");

    let result = SkillService::uninstall(&state.db, "local:backup-skill").expect("uninstall skill");
    let backup_path = result.backup_path.expect("backup path should be returned");
    let backup_dir = std::path::PathBuf::from(&backup_path);

    assert!(backup_dir.exists(), "backup directory should exist");
    assert!(
        backup_dir.join("skill").join("SKILL.md").exists(),
        "backup should include SKILL.md"
    );
    assert_eq!(
        fs::read_to_string(backup_dir.join("skill").join("prompt.md"))
            .expect("read backed up prompt"),
        "backup me"
    );

    let metadata: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(backup_dir.join("meta.json")).expect("read backup metadata"),
    )
    .expect("parse backup metadata");
    assert_eq!(metadata["skill"]["directory"], "backup-skill");
    assert_eq!(metadata["skill"]["name"], "Backup Skill");

    assert!(
        !ssot_skill_dir.exists(),
        "SSOT skill directory should be removed after uninstall"
    );
    assert!(
        state
            .db
            .get_installed_skill("local:backup-skill")
            .expect("query skill")
            .is_none(),
        "database row should be deleted after uninstall"
    );
}

#[test]
fn restore_skill_backup_restores_files_to_ssot_and_current_app() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let ssot_skill_dir = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills")
        .join("restore-skill");
    write_skill(&ssot_skill_dir, "Restore Skill");
    fs::write(ssot_skill_dir.join("prompt.md"), "restore me").expect("write prompt.md");

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_skill(&InstalledSkill {
            id: "local:restore-skill".to_string(),
            name: "Restore Skill".to_string(),
            description: Some("Bring the files back".to_string()),
            directory: "restore-skill".to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps {
                claude: true,
                ..Default::default()
            },
            installed_at: 456,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save skill");

    let uninstall =
        SkillService::uninstall(&state.db, "local:restore-skill").expect("uninstall skill");
    let backup_id = std::path::Path::new(
        &uninstall
            .backup_path
            .expect("backup path should be returned on uninstall"),
    )
    .file_name()
    .expect("backup dir name")
    .to_string_lossy()
    .to_string();

    let restored = SkillService::restore_from_backup(&state.db, &backup_id, &AppType::Claude)
        .expect("restore from backup");

    assert_eq!(restored.directory, "restore-skill");
    assert!(restored.apps.claude, "restored skill should enable Claude");
    assert!(
        !restored.apps.codex && !restored.apps.gemini && !restored.apps.opencode,
        "restore should only enable the selected app"
    );
    assert!(
        home.join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
            .join("skills")
            .join("restore-skill")
            .join("prompt.md")
            .exists(),
        "restored skill should exist in SSOT"
    );
    assert!(
        home.join(".claude")
            .join("skills")
            .join("restore-skill")
            .join("prompt.md")
            .exists(),
        "restored skill should sync to the selected app"
    );
    assert!(
        state
            .db
            .get_installed_skill("local:restore-skill")
            .expect("query restored skill")
            .is_some(),
        "restored skill should be written back to the database"
    );
}

#[test]
fn delete_skill_backup_removes_backup_directory() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    let ssot_skill_dir = home
        .join(chimera_plus_plus_lib::product_policy::PRODUCT_DATA_DIR)
        .join("skills")
        .join("delete-backup-skill");
    write_skill(&ssot_skill_dir, "Delete Backup Skill");

    let state = create_test_state().expect("create test state");
    state
        .db
        .save_skill(&InstalledSkill {
            id: "local:delete-backup-skill".to_string(),
            name: "Delete Backup Skill".to_string(),
            description: Some("Remove my backup".to_string()),
            directory: "delete-backup-skill".to_string(),
            repo_owner: None,
            repo_name: None,
            repo_branch: None,
            readme_url: None,
            apps: SkillApps {
                claude: true,
                ..Default::default()
            },
            installed_at: 789,
            content_hash: None,
            updated_at: 0,
        })
        .expect("save skill");

    let uninstall =
        SkillService::uninstall(&state.db, "local:delete-backup-skill").expect("uninstall skill");
    let backup_path = uninstall
        .backup_path
        .expect("backup path should be returned on uninstall");
    let backup_id = std::path::Path::new(&backup_path)
        .file_name()
        .expect("backup dir name")
        .to_string_lossy()
        .to_string();

    assert!(
        std::path::Path::new(&backup_path).exists(),
        "backup directory should exist before deletion"
    );

    SkillService::delete_backup(&backup_id).expect("delete backup");

    assert!(
        !std::path::Path::new(&backup_path).exists(),
        "backup directory should be removed"
    );
    assert!(
        SkillService::list_backups()
            .expect("list backups")
            .into_iter()
            .all(|entry| entry.backup_id != backup_id),
        "deleted backup should no longer appear in backup list"
    );
}

#[test]
fn migration_snapshot_overrides_multi_source_directory_inference() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();

    write_skill(
        &home.join(".claude").join("skills").join("demo-skill"),
        "Demo",
    );
    write_skill(
        &home
            .join(".config")
            .join("opencode")
            .join("skills")
            .join("demo-skill"),
        "Demo",
    );

    let state = create_test_state().expect("create test state");
    state
        .db
        .set_setting(
            "skills_ssot_migration_snapshot",
            r#"[{"directory":"demo-skill","app_type":"claude"}]"#,
        )
        .expect("seed migration snapshot");

    let count = migrate_skills_to_ssot(&state.db).expect("migrate skills to ssot");
    assert_eq!(count, 1, "expected one migrated skill");

    let skills = state.db.get_all_installed_skills().expect("get skills");
    let migrated = skills
        .values()
        .find(|skill| skill.directory == "demo-skill")
        .expect("migrated demo-skill");

    assert!(
        migrated.apps.claude,
        "legacy snapshot should preserve Claude enablement"
    );
    assert!(
        !migrated.apps.opencode,
        "migration should no longer infer OpenCode enablement from a duplicate directory alone"
    );
}

#[test]
fn explicit_import_preserves_an_identical_existing_target_as_an_unmanaged_directory() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    let source = home.join(".claude/skills/identical-existing");
    let target = home.join(".codex/skills/identical-existing");
    for path in [&source, &target] {
        write_skill(path, "Identical existing target");
        fs::create_dir(path.join(".config")).unwrap();
        fs::write(path.join(".config/policy.md"), b"local hidden policy").unwrap();
    }
    let target_doc = fs::read(target.join("SKILL.md")).unwrap();
    let state = create_test_state().unwrap();
    let snapshot = SkillService::scan_unmanaged_scoped(&state.db, Some(AppType::Claude))
        .unwrap()
        .into_iter()
        .find(|row| row.directory == "identical-existing")
        .unwrap();
    let imported = SkillService::import_from_apps(
        &state.db,
        vec![ImportSkillSelection {
            directory: snapshot.directory,
            source_path: Some(snapshot.path),
            content_hash: Some(snapshot.content_hash),
            apps: SkillApps::only(&AppType::Codex),
        }],
    )
    .unwrap();
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0].apps.enabled_apps(), vec![AppType::Codex]);
    assert!(!fs::symlink_metadata(&target)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(
        !target.join(".chimera-managed-skill").exists(),
        "import must not claim ownership of an existing directory"
    );
    assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), target_doc);
    assert_eq!(
        fs::read(target.join(".config/policy.md")).unwrap(),
        b"local hidden policy"
    );
    assert!(state
        .db
        .get_installed_skill("local:identical-existing")
        .unwrap()
        .is_some());
}

#[test]
fn hidden_target_conflict_does_not_overwrite_and_rolls_back_preceding_import() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let home = ensure_test_home();
    let first_source = home.join(".claude/skills/batch-first");
    let conflict_source = home.join(".claude/skills/batch-conflict");
    let existing_target = home.join(".codex/skills/batch-conflict");
    write_skill(&first_source, "First staged skill");
    for path in [&conflict_source, &existing_target] {
        write_skill(path, "Same visible content");
    }
    fs::write(conflict_source.join(".policy"), b"incoming hidden policy").unwrap();
    fs::write(
        existing_target.join(".policy"),
        b"keep existing hidden policy",
    )
    .unwrap();
    assert_eq!(
        SkillService::compute_dir_hash(&conflict_source).unwrap(),
        SkillService::compute_dir_hash(&existing_target).unwrap()
    );
    let target_doc = fs::read(existing_target.join("SKILL.md")).unwrap();
    let source_doc = fs::read(first_source.join("SKILL.md")).unwrap();
    let state = create_test_state().unwrap();
    let scanned = SkillService::scan_unmanaged_scoped(&state.db, Some(AppType::Claude)).unwrap();
    let imports = ["batch-first", "batch-conflict"]
        .into_iter()
        .map(|directory| {
            let row = scanned
                .iter()
                .find(|row| row.directory == directory)
                .unwrap();
            ImportSkillSelection {
                directory: row.directory.clone(),
                source_path: Some(row.path.clone()),
                content_hash: Some(row.content_hash.clone()),
                apps: SkillApps::only(&AppType::Codex),
            }
        })
        .collect();
    let error = SkillService::import_from_apps(&state.db, imports).unwrap_err();
    assert!(
        error.to_string().contains("内容不同，未覆盖已有文件"),
        "{error:#}"
    );
    assert!(state.db.get_all_installed_skills().unwrap().is_empty());
    let ssot = SkillService::get_ssot_dir().unwrap();
    assert!(!ssot.join("batch-first").exists());
    assert!(!ssot.join("batch-conflict").exists());
    assert!(fs::symlink_metadata(home.join(".codex/skills/batch-first")).is_err());
    assert_eq!(
        fs::read(existing_target.join("SKILL.md")).unwrap(),
        target_doc
    );
    assert_eq!(
        fs::read(existing_target.join(".policy")).unwrap(),
        b"keep existing hidden policy"
    );
    assert!(!existing_target.join(".chimera-managed-skill").exists());
    assert_eq!(
        fs::read(conflict_source.join(".policy")).unwrap(),
        b"incoming hidden policy"
    );
    assert_eq!(fs::read(first_source.join("SKILL.md")).unwrap(), source_doc);
}
