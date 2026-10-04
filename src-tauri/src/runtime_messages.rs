//! User-facing wording for the messages the Codex runtime engine reports.
//!
//! The engine is an English-language library. Known messages are rewritten into
//! product copy; anything else is kept verbatim behind a Chinese lead-in so the
//! cause is never lost and no message is silently dropped.

/// One known engine message: a lowercase fragment to look for, and the product
/// copy to show instead.
struct KnownMessage {
    fragment: &'static str,
    zh: &'static str,
}

const KNOWN: &[KnownMessage] = &[
    KnownMessage {
        fragment: "portable codex install completed",
        zh: "Codex 免安装版安装完成",
    },
    KnownMessage {
        fragment: "msix sideloading appears blocked",
        zh: "Windows 当前不允许安装 Codex 标准版，建议改用免安装版",
    },
    KnownMessage {
        fragment: "codex startup dialog",
        zh: "Codex 启动时出现原生对话框，无法确认启动成功，请检查 Codex 窗口",
    },
    KnownMessage {
        fragment: "health probe timed out; routed to portable fallback",
        zh: "标准版启动检查超时，已改用免安装版",
    },
    KnownMessage {
        fragment: "health probe could not run; routed to portable fallback",
        zh: "无法运行标准版启动检查，已改用免安装版",
    },
    KnownMessage {
        fragment: "portable codex is missing its bundled cli",
        zh: "免安装版缺少内置的命令行组件，请在更新页重新安装",
    },
    KnownMessage {
        fragment: "invalid portable launch target",
        zh: "免安装版的启动目标无效，请在更新页重新安装",
    },
];

/// Returns product copy for a known engine message, otherwise the original text
/// behind a short Chinese lead-in. Text that is already Chinese (our own
/// messages, or localized OS errors) passes through unchanged.
pub(crate) fn localize_engine_message(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(known) = KNOWN.iter().find(|known| lower.contains(known.fragment)) {
        return if trimmed.len() <= known.fragment.len() + 2 {
            format!("{}。", known.zh)
        } else {
            format!("{}。原始信息：{trimmed}", known.zh)
        };
    }
    if trimmed.chars().any(is_cjk) {
        return trimmed.to_string();
    }
    format!("Codex 运行时报告：{trimmed}")
}

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

#[cfg(test)]
mod tests {
    use super::localize_engine_message;

    #[test]
    fn known_messages_become_product_copy() {
        assert_eq!(
            localize_engine_message("Portable Codex install completed."),
            "Codex 免安装版安装完成。"
        );
    }

    #[test]
    fn known_messages_keep_their_original_detail() {
        let text = localize_engine_message(
            "MSIX sideloading appears blocked; use the portable fallback (AppX policy 0x80073d28)",
        );
        assert!(
            text.starts_with("Windows 当前不允许安装 Codex 标准版"),
            "{text}"
        );
        assert!(
            text.contains("原始信息：MSIX sideloading appears blocked"),
            "{text}"
        );
        assert!(text.contains("0x80073d28"), "{text}");
    }

    #[test]
    fn startup_dialog_failures_are_recognised_with_their_failure_text() {
        let text =
            localize_engine_message("Codex startup dialog: The application was unable to start");
        assert!(text.starts_with("Codex 启动时出现原生对话框"), "{text}");
        assert!(text.contains("unable to start"), "{text}");
    }

    #[test]
    fn unknown_english_messages_are_kept_behind_a_lead_in() {
        assert_eq!(
            localize_engine_message("disk quota exceeded"),
            "Codex 运行时报告：disk quota exceeded"
        );
    }

    #[test]
    fn chinese_messages_pass_through_unchanged() {
        assert_eq!(
            localize_engine_message("  Codex 未能完全退出，已取消重启 "),
            "Codex 未能完全退出，已取消重启"
        );
    }
}
