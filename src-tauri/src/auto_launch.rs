use crate::error::AppError;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

/// 获取 macOS 上的 .app bundle 路径
/// 将 macOS 可执行文件路径转换为其 `.app` bundle 路径。
#[cfg(target_os = "macos")]
fn get_macos_app_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let path_str = exe_path.to_string_lossy();
    // 查找 .app/Contents/MacOS/ 模式
    if let Some(app_pos) = path_str.find(".app/Contents/MacOS/") {
        let app_bundle_end = app_pos + 4; // ".app" 的结束位置
        Some(std::path::PathBuf::from(&path_str[..app_bundle_end]))
    } else {
        None
    }
}

/// 初始化 AutoLaunch 实例
fn get_auto_launch() -> Result<AutoLaunch, AppError> {
    let app_name = crate::product_policy::PRODUCT_NAME;
    let exe_path =
        std::env::current_exe().map_err(|e| AppError::Message(format!("无法获取应用路径: {e}")))?;

    // macOS 需要使用 .app bundle 路径，否则 AppleScript login item 会打开终端
    #[cfg(target_os = "macos")]
    let app_path = get_macos_app_bundle_path(&exe_path).unwrap_or(exe_path);

    #[cfg(not(target_os = "macos"))]
    let app_path = exe_path;

    // Windows: the `auto-launch` crate writes the HKCU `Run` value as an
    // unquoted `"{app_path} {args}"` command line. An install path containing
    // spaces (e.g. a username with a space in it, which Windows allows and
    // does not warn about) then parses ambiguously — `CreateProcess` tries
    // each space-delimited prefix as a candidate executable before falling
    // back to the full string, which is the classic unquoted-path-service
    // hazard. Quote the path ourselves before handing it to the builder; the
    // resulting `"C:\...\Chimera++.exe" ` (empty args leave a harmless
    // trailing space after the closing quote) parses unambiguously.
    #[cfg(target_os = "windows")]
    let app_path_arg = format!("\"{}\"", app_path.to_string_lossy());
    #[cfg(not(target_os = "windows"))]
    let app_path_arg = app_path.to_string_lossy().into_owned();

    // 使用 AutoLaunchBuilder 消除平台差异
    // macOS: 使用 AppleScript 方式（默认），需要 .app bundle 路径
    // Windows/Linux: 使用注册表/XDG autostart
    let auto_launch = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&app_path_arg)
        .build()
        .map_err(|e| AppError::Message(format!("创建 AutoLaunch 失败: {e}")))?;

    Ok(auto_launch)
}

/// 启用开机自启
pub fn enable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .enable()
        .map_err(|e| AppError::Message(format!("启用开机自启失败: {e}")))?;
    log::info!("已启用开机自启");
    Ok(())
}

/// 禁用开机自启
pub fn disable_auto_launch() -> Result<(), AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .disable()
        .map_err(|e| AppError::Message(format!("禁用开机自启失败: {e}")))?;
    log::info!("已禁用开机自启");
    Ok(())
}

/// 检查是否已启用开机自启
pub fn is_auto_launch_enabled() -> Result<bool, AppError> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .is_enabled()
        .map_err(|e| AppError::Message(format!("检查开机自启状态失败: {e}")))
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_valid() {
        let exe_path = std::path::Path::new("/Applications/Chimera++.app/Contents/MacOS/Chimera++");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from("/Applications/Chimera++.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_with_spaces() {
        let exe_path =
            std::path::Path::new("/Users/test/My Apps/Chimera++.app/Contents/MacOS/Chimera++");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(
            result,
            Some(std::path::PathBuf::from(
                "/Users/test/My Apps/Chimera++.app"
            ))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_not_in_bundle() {
        let exe_path = std::path::Path::new("/usr/local/bin/chimera-plus-plus");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_get_macos_app_bundle_path_dev_build() {
        // 开发环境下的路径通常不在 .app bundle 内
        let exe_path = std::path::Path::new("/Users/dev/project/target/debug/chimera-plus-plus");
        let result = get_macos_app_bundle_path(exe_path);
        assert_eq!(result, None);
    }
}
