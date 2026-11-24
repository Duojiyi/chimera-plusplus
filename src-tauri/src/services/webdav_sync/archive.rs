use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tempfile::{tempdir, TempDir};
use zip::write::SimpleFileOptions;
use zip::DateTime;

use crate::error::AppError;
use crate::services::skill::SkillService;

use crate::services::sync_protocol::{
    io_context_localized, localized, MAX_SYNC_ARTIFACT_BYTES, REMOTE_SKILLS_ZIP,
};

/// Maximum number of entries allowed in a zip archive.
const MAX_EXTRACT_ENTRIES: usize = 10_000;

pub(crate) struct SkillsBackup {
    tmp: TempDir,
    backup_dir: PathBuf,
    ssot_path: PathBuf,
    existed: bool,
}

pub(crate) fn zip_skills_ssot(dest_path: &Path) -> Result<(), AppError> {
    let source = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }

    let file = fs::File::create(dest_path).map_err(|e| AppError::io(dest_path, e))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(DateTime::default());

    if source.exists() {
        let canonical_root = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        let mut visited = HashSet::new();
        mark_visited_dir(&canonical_root, &mut visited)?;
        let mut total_zip_bytes: u64 = 0;
        zip_dir_recursive(
            &canonical_root,
            &canonical_root,
            &mut writer,
            options,
            &mut visited,
            &mut total_zip_bytes,
        )?;
    }

    writer.finish().map_err(|e| {
        localized(
            "webdav.sync.skills_zip_write_failed",
            format!("写入 skills.zip 失败: {e}"),
            format!("Failed to write skills.zip: {e}"),
        )
    })?;
    Ok(())
}

fn has_unsafe_archive_component(path: &Path) -> bool {
    path.components().any(|component| {
        let Some(name) = component.as_os_str().to_str() else {
            return true;
        };
        if name.is_empty() || name.ends_with([' ', '.']) {
            return true;
        }
        if name
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        {
            return true;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    })
}

pub(crate) fn restore_skills_zip(raw: &[u8]) -> Result<(), AppError> {
    let tmp = tempdir().map_err(|e| {
        io_context_localized(
            "webdav.sync.skills_extract_tmpdir_failed",
            "创建 skills 解压临时目录失败",
            "Failed to create temporary directory for skills extraction",
            e,
        )
    })?;
    let zip_path = tmp.path().join(REMOTE_SKILLS_ZIP);
    fs::write(&zip_path, raw).map_err(|e| AppError::io(&zip_path, e))?;

    let file = fs::File::open(&zip_path).map_err(|e| AppError::io(&zip_path, e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        localized(
            "webdav.sync.skills_zip_parse_failed",
            format!("解析 skills.zip 失败: {e}"),
            format!("Failed to parse skills.zip: {e}"),
        )
    })?;

    let extracted = tmp.path().join("skills-extracted");
    fs::create_dir_all(&extracted).map_err(|e| AppError::io(&extracted, e))?;

    if archive.len() > MAX_EXTRACT_ENTRIES {
        return Err(localized(
            "webdav.sync.skills_zip_too_many_entries",
            format!(
                "skills.zip 条目数过多（{}），上限 {MAX_EXTRACT_ENTRIES}",
                archive.len()
            ),
            format!(
                "skills.zip has too many entries ({}), limit is {MAX_EXTRACT_ENTRIES}",
                archive.len()
            ),
        ));
    }

    let mut total_bytes: u64 = 0;
    for idx in 0..archive.len() {
        let mut entry = archive.by_index(idx).map_err(|e| {
            localized(
                "webdav.sync.skills_zip_entry_read_failed",
                format!("读取 ZIP 项失败: {e}"),
                format!("Failed to read ZIP entry: {e}"),
            )
        })?;
        let Some(safe_name) = entry.enclosed_name() else {
            continue;
        };
        if has_unsafe_archive_component(&safe_name) {
            return Err(localized(
                "webdav.sync.skills_zip_unsafe_entry",
                "skills.zip 包含不安全的文件名（保留设备名或非法字符），已拒绝解压".to_string(),
                "skills.zip contains an unsafe entry name (reserved device name or invalid characters)".to_string(),
            ));
        }
        let out_path = extracted.join(safe_name);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| AppError::io(&out_path, e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| AppError::io(&out_path, e))?;
        let _written = copy_entry_with_total_limit(
            &mut entry,
            &mut out,
            &mut total_bytes,
            MAX_SYNC_ARTIFACT_BYTES,
            &out_path,
        )?;
    }

    let ssot = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    let ssot_parent = ssot.parent().ok_or_else(|| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            "Skills SSOT 父目录无效".to_string(),
            "Invalid Skills SSOT parent directory".to_string(),
        )
    })?;
    fs::create_dir_all(ssot_parent).map_err(|e| AppError::io(ssot_parent, e))?;
    let bak_holder = tempfile::Builder::new()
        .prefix(".skills-restore-bak-")
        .tempdir_in(ssot_parent)
        .map_err(|e| AppError::io(ssot_parent, e))?;
    let bak = bak_holder.path().join("skills-backup");

    if ssot.exists() {
        fs::rename(&ssot, &bak).map_err(|e| AppError::io(&ssot, e))?;
    }

    if let Err(e) = copy_dir_recursive(&extracted, &ssot) {
        if bak.exists() {
            let mut rollback_errs = Vec::new();
            if ssot.exists() {
                if let Err(rm_err) = fs::remove_dir_all(&ssot) {
                    rollback_errs.push(format!("清理失败的目标目录失败: {rm_err}"));
                }
            }
            if let Err(rename_err) = fs::rename(&bak, &ssot) {
                rollback_errs.push(format!("恢复备份目录失败: {rename_err}"));
            }
            if !rollback_errs.is_empty() {
                return Err(localized(
                    "webdav.sync.skills_copy_and_rollback_failed",
                    format!(
                        "复制 Skills 目录失败: {e}; 且回滚过程出现错误: {}",
                        rollback_errs.join("; ")
                    ),
                    format!(
                        "Failed to copy skills directory: {e}; and rollback encountered errors: {}",
                        rollback_errs.join("; ")
                    ),
                ));
            }
        }
        return Err(e);
    }

    drop(bak_holder);
    Ok(())
}

pub(crate) fn backup_current_skills() -> Result<SkillsBackup, AppError> {
    let ssot = SkillService::get_ssot_dir().map_err(|e| {
        localized(
            "webdav.sync.skills_ssot_dir_failed",
            format!("获取 Skills SSOT 目录失败: {e}"),
            format!("Failed to resolve Skills SSOT directory: {e}"),
        )
    })?;
    let tmp = tempdir().map_err(|e| {
        io_context_localized(
            "webdav.sync.skills_backup_tmpdir_failed",
            "创建 skills 备份临时目录失败",
            "Failed to create temporary directory for skills backup",
            e,
        )
    })?;
    let backup_dir = tmp.path().join("skills-backup");

    let existed = ssot.exists();
    if existed {
        copy_dir_recursive(&ssot, &backup_dir)?;
    }

    Ok(SkillsBackup {
        tmp,
        backup_dir,
        ssot_path: ssot,
        existed,
    })
}

pub(crate) fn restore_skills_from_backup(backup: SkillsBackup) -> Result<(), AppError> {
    match restore_skills_backup_contents(&backup) {
        Ok(()) => Ok(()),
        Err(error) => {
            let retained = backup.tmp.keep();
            Err(localized(
                "sync.skills_rollback_backup_retained",
                format!(
                    "回滚 Skills 失败: {error}; 恢复备份保留于 {}",
                    retained.display()
                ),
                format!(
                    "Skills rollback failed: {error}; recovery backup retained at {}",
                    retained.display()
                ),
            ))
        }
    }
}

fn restore_skills_backup_contents(backup: &SkillsBackup) -> Result<(), AppError> {
    if backup.ssot_path.exists() {
        fs::remove_dir_all(&backup.ssot_path).map_err(|e| AppError::io(&backup.ssot_path, e))?;
    }

    if backup.existed {
        copy_dir_recursive(&backup.backup_dir, &backup.ssot_path)?;
    }

    Ok(())
}

fn zip_dir_recursive(
    root: &Path,
    current: &Path,
    writer: &mut zip::ZipWriter<fs::File>,
    options: SimpleFileOptions,
    visited: &mut HashSet<PathBuf>,
    total_zip_bytes: &mut u64,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(current)
        .map_err(|e| AppError::io(current, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::io(current, e))?;
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with('.') {
            continue;
        }

        let real_path = match fs::canonicalize(&path) {
            Ok(p) if p.starts_with(root) => p,
            Ok(_) => {
                log::warn!(
                    "[WebDAV] Skipping symlink outside skills root: {}",
                    path.display()
                );
                continue;
            }
            Err(error) if is_skill_link(&path) => {
                log::warn!(
                    "[WebDAV] Skipping unresolvable link in skills: {}: {error}",
                    path.display()
                );
                continue;
            }
            Err(_) => path.clone(),
        };

        let rel = real_path
            .strip_prefix(root)
            .or_else(|_| path.strip_prefix(root))
            .map_err(|e| {
                localized(
                    "webdav.sync.zip_relative_path_failed",
                    format!("生成 ZIP 相对路径失败: {e}"),
                    format!("Failed to build relative ZIP path: {e}"),
                )
            })?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        if real_path.is_dir() {
            if !mark_visited_dir(&real_path, visited)? {
                log::warn!(
                    "[WebDAV] Skipping already visited directory: {}",
                    real_path.display()
                );
                continue;
            }
            writer
                .add_directory(format!("{rel_str}/"), options)
                .map_err(|e| {
                    localized(
                        "webdav.sync.zip_add_directory_failed",
                        format!("写入 ZIP 目录失败: {e}"),
                        format!("Failed to write ZIP directory entry: {e}"),
                    )
                })?;
            zip_dir_recursive(root, &real_path, writer, options, visited, total_zip_bytes)?;
        } else {
            let remaining = MAX_SYNC_ARTIFACT_BYTES.saturating_sub(*total_zip_bytes);
            let buf = crate::security_limits::read_limited(&real_path, remaining).map_err(|e| {
                localized(
                    "webdav.sync.skills_zip_too_large",
                    format!(
                        "打包 Skills 文件超出安全体积上限: {}: {e}",
                        real_path.display()
                    ),
                    format!(
                        "Skill file exceeds archive size limit: {}: {e}",
                        real_path.display()
                    ),
                )
            })?;
            *total_zip_bytes = total_zip_bytes.saturating_add(buf.len() as u64);
            writer.start_file(&rel_str, options).map_err(|e| {
                localized(
                    "webdav.sync.zip_start_file_failed",
                    format!("写入 ZIP 文件头失败: {e}"),
                    format!("Failed to start ZIP file entry: {e}"),
                )
            })?;
            writer.write_all(&buf).map_err(|e| {
                localized(
                    "webdav.sync.zip_write_file_failed",
                    format!("写入 ZIP 文件内容失败: {e}"),
                    format!("Failed to write ZIP file content: {e}"),
                )
            })?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), AppError> {
    let mut visited = HashSet::new();
    let canonical_root = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    copy_dir_recursive_inner(&canonical_root, src, dest, &mut visited)
}

fn copy_dir_recursive_inner(
    root: &Path,
    src: &Path,
    dest: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<(), AppError> {
    if !src.exists() {
        return Ok(());
    }
    if !mark_visited_dir(src, visited)? {
        log::warn!(
            "[WebDAV] Skipping already visited copy path: {}",
            src.display()
        );
        return Ok(());
    }
    fs::create_dir_all(dest).map_err(|e| AppError::io(dest, e))?;
    for entry in fs::read_dir(src).map_err(|e| AppError::io(src, e))? {
        let entry = entry.map_err(|e| AppError::io(src, e))?;
        let path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&path).map_err(|e| AppError::io(&path, e))?;
        if crate::security_limits::is_link_or_reparse_point(&meta) {
            match fs::canonicalize(&path) {
                Ok(resolved) if resolved.starts_with(root) => {
                    // Only allow internal links that stay strictly within the source root.
                }
                Ok(_) => {
                    log::warn!(
                        "[WebDAV] Skipping link escaping skills root: {}",
                        path.display()
                    );
                    continue;
                }
                Err(error) => {
                    log::warn!(
                        "[WebDAV] Skipping unresolvable link in skills: {}: {error}",
                        path.display()
                    );
                    continue;
                }
            }
        }
        if path.is_dir() {
            copy_dir_recursive_inner(root, &path, &dest_path, visited)?;
        } else {
            fs::copy(&path, &dest_path).map_err(|e| AppError::io(&dest_path, e))?;
        }
    }
    Ok(())
}

// Adapted from farion1231/cc-switch f94b702affe0e4ee1d7f557efbe91a22010503e7 (MIT).
// Copyright (c) 2025 Jason Young. Modified: keep the local root and cycle guards.
// Inspect the entry itself, not its target. Rust 1.95 also identifies Windows
// junctions as symlinks; unrelated reparse points and regular-file errors are
// not eligible for the unresolvable-link exception.
fn is_skill_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn mark_visited_dir(path: &Path, visited: &mut HashSet<PathBuf>) -> Result<bool, AppError> {
    let canonical = fs::canonicalize(path).map_err(|e| AppError::io(path, e))?;
    Ok(visited.insert(canonical))
}

fn copy_entry_with_total_limit<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_bytes: &mut u64,
    max_total_bytes: u64,
    out_path: &Path,
) -> Result<u64, AppError> {
    let mut buffer = [0u8; 16 * 1024];
    let mut written = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| AppError::io(out_path, e))?;
        if n == 0 {
            break;
        }

        if total_bytes.saturating_add(n as u64) > max_total_bytes {
            let max_mb = max_total_bytes / 1024 / 1024;
            return Err(localized(
                "webdav.sync.skills_zip_too_large",
                format!("skills.zip 解压后体积超过上限（{max_mb} MB）"),
                format!("skills.zip extracted size exceeds limit ({max_mb} MB)"),
            ));
        }

        writer
            .write_all(&buffer[..n])
            .map_err(|e| AppError::io(out_path, e))?;
        *total_bytes += n as u64;
        written += n as u64;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::{copy_entry_with_total_limit, mark_visited_dir};
    use std::collections::HashSet;
    use std::io::Cursor;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn rollback_failure_retains_recovery_backup() {
        let target = tempdir().unwrap();
        let blocked_parent = target.path().join("blocked");
        std::fs::write(&blocked_parent, "not a directory").unwrap();
        let tmp = tempdir().unwrap();
        let retained = tmp.path().to_path_buf();
        let backup_dir = retained.join("skills-backup");
        std::fs::create_dir(&backup_dir).unwrap();
        std::fs::write(backup_dir.join("original.txt"), "original").unwrap();
        let error = super::restore_skills_from_backup(super::SkillsBackup {
            tmp,
            backup_dir: backup_dir.clone(),
            ssot_path: blocked_parent.join("skills"),
            existed: true,
        })
        .expect_err("blocked destination must fail");
        assert!(error.to_string().contains(&retained.display().to_string()));
        assert_eq!(
            std::fs::read_to_string(backup_dir.join("original.txt")).unwrap(),
            "original"
        );
        std::fs::remove_dir_all(retained).unwrap();
    }

    #[test]
    fn mark_visited_dir_tracks_canonical_duplicates() {
        let temp = tempdir().expect("tempdir");
        let dir = temp.path().join("skills");
        std::fs::create_dir_all(&dir).expect("create dir");

        let mut visited = HashSet::new();
        assert!(mark_visited_dir(&dir, &mut visited).expect("first visit"));
        assert!(!mark_visited_dir(&dir, &mut visited).expect("second visit"));
    }

    #[test]
    fn copy_entry_with_total_limit_rejects_oversized_stream_before_write() {
        let mut reader = Cursor::new(vec![1u8; 16]);
        let mut writer = Vec::new();
        let mut total_bytes = 0u64;

        let err = copy_entry_with_total_limit(
            &mut reader,
            &mut writer,
            &mut total_bytes,
            8,
            Path::new("skills-extracted/file.bin"),
        )
        .expect_err("stream larger than limit should be rejected");
        assert!(
            err.to_string().contains("too large") || err.to_string().contains("超过"),
            "unexpected error: {err}"
        );
        assert_eq!(
            writer.len(),
            0,
            "should not write when the first chunk exceeds limit"
        );
    }

    #[cfg(any(unix, windows))]
    fn link_skill_directory(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Junctions work without Windows Developer Mode or symlink privileges.
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link.components().collect::<std::path::PathBuf>())
                .arg(target.components().collect::<std::path::PathBuf>())
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        assert!(super::is_skill_link(link));
    }

    fn skill_zip_files(
        source: &Path,
    ) -> Result<std::collections::BTreeMap<String, Vec<u8>>, crate::error::AppError> {
        use std::io::Read;

        let temp = tempdir().unwrap();
        let archive_path = temp.path().join("skills.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        let root = std::fs::canonicalize(source).unwrap();
        let mut visited = HashSet::new();
        mark_visited_dir(&root, &mut visited)?;
        super::zip_dir_recursive(
            &root,
            &root,
            &mut writer,
            zip::write::SimpleFileOptions::default(),
            &mut visited,
            &mut 0u64,
        )?;
        writer.finish().unwrap();
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();
        let mut files = std::collections::BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if !entry.is_dir() {
                let name = entry.name().unwrap().into_owned();
                let mut contents = Vec::new();
                entry.read_to_end(&mut contents).unwrap();
                assert!(files.insert(name, contents).is_none(), "duplicate ZIP file");
            }
        }
        Ok(files)
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_link_sync_skips_top_level_and_nested_dangling_directories() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        let nested = source.join("valid");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("SKILL.md"), "keep skill").unwrap();
        for (index, link) in [source.join("broken"), nested.join("broken")]
            .into_iter()
            .enumerate()
        {
            let target = temp.path().join(format!("removed-target-{index}"));
            std::fs::create_dir(&target).unwrap();
            link_skill_directory(&target, &link);
            std::fs::remove_dir(&target).unwrap();
            assert!(super::is_skill_link(&link));
            assert!(std::fs::canonicalize(&link).is_err());
        }

        let files = skill_zip_files(&source).expect("dangling links must not abort ZIP");
        assert_eq!(files.len(), 1);
        assert_eq!(files["valid/SKILL.md"], b"keep skill");
        let dest = temp.path().join("copied");
        super::copy_dir_recursive(&source, &dest).expect("dangling links must not abort copy");
        assert_eq!(
            std::fs::read(dest.join("valid/SKILL.md")).unwrap(),
            b"keep skill"
        );
        for link in [dest.join("broken"), dest.join("valid/broken")] {
            assert_eq!(
                std::fs::symlink_metadata(link).unwrap_err().kind(),
                std::io::ErrorKind::NotFound
            );
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_link_sync_preserves_valid_internal_links_and_cycle_guards() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        let skill = source.join("z-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "linked skill").unwrap();
        link_skill_directory(&skill, &source.join("a-alias"));
        link_skill_directory(&source, &skill.join("loop"));
        link_skill_directory(&source, &source.join("root-loop"));

        let files = skill_zip_files(&source).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files["z-skill/SKILL.md"], b"linked skill");
        let dest = temp.path().join("copied");
        super::copy_dir_recursive(&source, &dest).unwrap();
        // Directory enumeration may visit the alias or its target first.
        let copied = [dest.join("a-alias"), dest.join("z-skill")];
        let present: Vec<_> = copied.iter().filter(|path| path.exists()).collect();
        assert_eq!(present.len(), 1, "copy canonical directories only once");
        assert_eq!(
            std::fs::read(present[0].join("SKILL.md")).unwrap(),
            b"linked skill"
        );
        assert!(!present[0].join("loop").exists());
        assert!(!dest.join("root-loop").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_link_sync_zip_still_excludes_targets_outside_root() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(source.join("SKILL.md"), "local").unwrap();
        std::fs::write(outside.join("private.txt"), "private").unwrap();
        link_skill_directory(&outside, &source.join("external"));

        let files = skill_zip_files(&source).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files["SKILL.md"], b"local");
    }

    #[cfg(unix)]
    #[test]
    fn skills_link_sync_skips_dangling_file_symlinks() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "keep").unwrap();
        std::os::unix::fs::symlink(source.join("missing.txt"), source.join("broken.txt")).unwrap();

        let files = skill_zip_files(&source).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files["SKILL.md"], b"keep");
        let dest = temp.path().join("copied");
        super::copy_dir_recursive(&source, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("SKILL.md")).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(dest.join("broken.txt")).is_err());
    }

    #[test]
    fn skills_link_sync_regular_file_copy_errors_still_fail() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        let dest = temp.path().join("copied");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "keep").unwrap();
        std::fs::create_dir_all(dest.join("SKILL.md")).unwrap();

        assert!(super::copy_dir_recursive(&source, &dest).is_err());
        assert_eq!(std::fs::read(source.join("SKILL.md")).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn skills_link_sync_locked_regular_files_still_fail_zip_and_copy() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp = tempdir().unwrap();
        let source = temp.path().join("skills");
        std::fs::create_dir(&source).unwrap();
        let file = source.join("SKILL.md");
        std::fs::write(&file, "locked").unwrap();
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        assert!(!super::is_skill_link(&file));
        assert!(skill_zip_files(&source).is_err());
        assert!(super::copy_dir_recursive(&source, &temp.path().join("copied")).is_err());
        drop(locked);
    }
}
