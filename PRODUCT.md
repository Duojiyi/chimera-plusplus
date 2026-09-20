# Product

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

- Marketplace-style provider promotion, affiliate links, sponsored templates, or upstream project attribution in customer-facing product surfaces.
- A crowded admin dashboard made from equally weighted cards, small gray text, and decorative metrics.
- Fake macOS traffic lights, novelty window chrome, and visual effects that conflict with Windows conventions.
- Security-product cliches such as flat world maps with threat markers, animated scanning rings, neon gradients, or fear-based warning language. The 供应商 route globe added in v2.3.0 is a deliberate, bounded exception, recorded under Visual Research Reference.
- Motion that delays use, repeats on every page load, or makes state unclear.

## Navigation and Product Scope

Provider configuration is Codex-only: no other tool gets a connection, model, or runtime screen, and the dormant multi-tool backend stays internal. The one deliberate exception is 会话, which reads session logs written by whatever CLIs are installed locally — its provider filter therefore names Claude Code, Gemini CLI, Grok Build, and OpenCode alongside Codex. That surface manages local session history, including confirmed single and batch deletion, not provider configuration, and it is the only regular navigation surface for non-Codex tools. Explicit deep-link requests retain the inherited confirmation-only import flow for compatibility; they do not add multi-tool management screens.

The shipped navigation is a six-item bottom bar, not a sidebar:

1. **供应商**: the primary route. Active provider, active model, connection state, quick switching, a single path into provider editing, and the Codex start/restart action.
2. **更新**: Codex runtime install discovery, stable or portable distribution choice, update source, version comparison, repair, rollback, and uninstall with explicit confirmation.
3. **词元**: request counts, token consumption, per-model distribution, and history.
4. **外观**: browse, preview, install, apply, and restore Codex client skins.
5. **会话**: browse local session logs across installed CLIs with search and a provider filter; copy a resume command or the project directory, resume directly in a terminal on macOS, and delete single or selected sessions after confirmation.
6. **设置**: application update behavior, startup behavior, application data directory, and non-destructive preferences.

The 控制台 and 工具箱 destinations named in earlier drafts of this document were never shipped under those names; connection test, health scan, backup, and config transfer live inside the screens above rather than in a separate tools page.

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

The selected structural reference is Dribbble's [Internet Security and Privacy App - VPN v2](https://dribbble.com/shots/26489451-Internet-Security-and-Privacy-App-VPN-v2). Borrow only its focused connection-state composition, destination selector, and clear primary action hierarchy. Do not copy its gradients, palette, security branding, or assets.

The original instruction here was also "do not copy its globe". v2.3.0 reverses that one deliberately, and the reversal is bounded: the 供应商 route shows a dotted sphere generated at runtime from a public-domain Natural Earth 110m land mask, tinted entirely from the active palette, spinning slowly and honouring `prefers-reduced-motion` (default: slow, not freeze). It carries no routes, arcs, threat markers, scanning rings, or geographic claims — it is an idle-state ornament for the connection route, not a data visualization, and nothing about the user's provider is encoded in it. A flat map with markers remains banned. The secondary material reference is [Imgo](https://dribbble.com/shots/27225909-Imgo-a-file-tool-I-built-because-Windows-deserved-better): borrow its restrained native-window material and result-list clarity, not its dark palette or file-tool-specific visuals.
