# Product

This document describes the **v2.8 development target**, not the feature set of the latest published release. The version fields in the package and release metadata remain authoritative for release numbering. The current visual baseline is `designs/v2.8.0/designer-notes.md` and its exported frames; later explicit user feedback takes precedence over the historical wireframes.

## Register

product

## Platform

Desktop application built with Tauri 2. Windows is the primary platform; macOS and Linux releases have more limited Codex runtime maintenance capabilities.

## Users

Chimera++ serves Windows users who use Codex through an official installation, a portable distribution, or a third-party API gateway. The primary user is not expected to understand TOML, environment variables, protocol differences, or installation paths. Their immediate job is to see what Codex is connected to, switch safely, and recover from a broken configuration without editing files by hand.

## Product Purpose

Chimera++ is a clean, customer-ready Codex connection and runtime manager. It turns provider URL, API key, model selection, update source, and installation maintenance into a small number of clear, reversible desktop workflows. Success means a first-time user can configure or switch a provider confidently, while an experienced user can diagnose and maintain Codex without losing control of the underlying configuration.

## Positioning

The fastest trustworthy route between a user's Codex installation and the provider they want to use.

## Brand Personality

Quietly capable, exact, and reassuring. Chimera++ should feel like a refined desktop utility built for repeated use: decisive during a switch, calm while waiting, and explicit whenever an operation may alter local configuration. It must never resemble an advertising catalog, a generic SaaS dashboard, or a developer-only configuration editor.

## Anti-references

- Marketplace-style provider promotion, affiliate links, sponsored templates, or promotional upstream branding. License notices and accurate template provenance are permitted and must be retained.
- A crowded admin dashboard made from equally weighted cards, small gray text, and decorative metrics.
- Decorative window controls that do not operate the real window. Use platform-appropriate controls: macOS at the top left, Windows at the top right, with working minimize, maximize/restore, and close actions.
- Security-product cliches such as flat world maps with threat markers, animated scanning rings, neon gradients, or fear-based warning language. The historical v2.3 globe is not part of the v2.8 route design.
- Motion that delays use, repeats on every page load, or makes state unclear.

## Navigation and Product Scope

The v2.8 development app is Codex-first, with a capability-based sidebar. It must distinguish a tool that uses one current provider from tools that enable multiple entries. Other tools do not inherit Codex-only account, maintenance, or skin controls. Backend capability policy and the explicit tool-enablement flow remain authoritative; making a page visible must not silently import credentials or modify live configuration.

The current navigation is:

1. **Codex**: 线路, 官方账号, 提示词, Skills 与 MCP, 用量, Codex 管理, 外观, 配置体检.
2. **Other tools**: enabled tools get their supported provider/entry management page. The tool manager exposes real support and installation state; unimplemented tools must not receive empty working-looking screens. Customer-facing names are complete, including MiniMax Code.
3. **会话**: local session history across supported installed CLIs, with search, filtering, export where supported, and confirmation before deletion.
4. **设置**: tool management, explicit imports, local backup/recovery, general preferences, Codex preferences, and application updates.

The current delivery scope is Simplified Chinese and local data management. Multilingual completion and WebDAV/S3 cloud synchronization are excluded. The main UI does not expose language switching or cloud sync; backend cloud commands reject calls and cloud workers remain disabled. Existing translation resources and stored sync configuration are retained for compatibility, not activated or erased. Local backup/recovery, provider connections, outbound proxy configuration, and application updates remain in scope; local data management does not mean all network access is disabled.

The middle tool navigation scrolls independently; 会话 and 设置 remain reachable at the bottom. The settings content also has a bounded scroll region so every section is reachable at the minimum supported window size. “Codex 管理” is the customer-facing label; internal identifiers may continue to use “runtime”.

The previous six-item bottom navigation and Codex-only provider scope describe older releases and are not implementation requirements for v2.8. Deep-link imports still require explicit confirmation. Browser previews and design fixtures must be labelled and must not claim live local state or successful native operations.

The ChimeraHub template is the only customer-facing default template. Its URL remains editable. Users can create additional providers, but the product never promotes a provider catalog.

## Design Principles

1. **Connection is the product.** Every primary screen makes the current Codex route, its health, and the next safe action obvious within one glance.
2. **Progressive disclosure.** A beginner sees URL, key, model, test, and save; protocol, User-Agent, mapping, and other expert settings live behind a clear advanced disclosure.
3. **State earns motion.** Motion communicates switching, checking, saving, downloading, or recovery. Decoration never blocks work.
4. **Windows-native confidence.** Use familiar desktop control patterns and direct language. Destructive actions are visually isolated and always confirmed.
5. **No hidden sales layer.** User choices, status, and recovery tools take priority over promotions, upstream brand names, and unrelated presets.

## Accessibility & Inclusion

Meet WCAG 2.2 AA contrast for text and controls. All critical actions require keyboard access, visible focus, and explicit status text in addition to color. Respect `prefers-reduced-motion`; users can complete every workflow without non-essential animation. Chinese is the primary product language, with UI copy written in short, direct terms suitable for non-technical users.

## Visual Research Reference

The v2.8 direction is the transit-inspired route signboard with a restrained desktop shell and clear operation receipts, as documented in `designs/v2.8.0/designer-notes.md`. Color identifies routes and status; typography, spacing, dialogs, forms, and tables share the same semantic theme tokens. A successful compile does not constitute visual acceptance: the real populated, empty, loading, failure, disabled, and small-window states must be reviewed.

The former VPN/globe reference is historical only. The secondary material reference remains [Imgo](https://dribbble.com/shots/27225909-Imgo-a-file-tool-I-built-because-Windows-deserved-better): borrow restrained native-window material and result-list clarity, not its palette or file-tool-specific visuals.
