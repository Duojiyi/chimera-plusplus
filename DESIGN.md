---
version: v3
name: Chimera++ v3 Light Liquid Glass Desktop
description: A restrained, high-confidence Windows desktop system for Codex connection, multi-account, and runtime management.
colors:
  canvas: "#e4e9e4"
  surface: "rgba(255, 255, 255, 0.72)"
  surface-raised: "#FFFFFF"
  surface-subtle: "#eef2ee"
  ink: "#151b18"
  ink-muted: "#536059"
  line: "rgba(21, 27, 24, 0.09)"
  sidebar: "rgba(255, 255, 255, 0.56)"
  sidebar-raised: "rgba(31, 106, 74, 0.10)"
  accent: "#1f6a4a"
  accent-hover: "#18563b"
  accent-soft: "rgba(31, 106, 74, 0.12)"
  success: "#1f7a4c"
  success-soft: "rgba(31, 122, 76, 0.12)"
  warning: "#9a5b13"
  error: "#b4342c"
  focus: "#1f6a4a"
typography:
  title-lg:
    fontFamily: "Overpass, Noto Sans SC, system-ui, sans-serif"
    fontSize: 22px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: 0px
  title-md:
    fontFamily: "Overpass, Noto Sans SC, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: 0px
  body-md:
    fontFamily: "Overpass, Noto Sans SC, system-ui, sans-serif"
    fontSize: 13.5px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  body-sm:
    fontFamily: "Overpass, Noto Sans SC, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0px
  label-md:
    fontFamily: "Overpass, Noto Sans SC, system-ui, sans-serif"
    fontSize: 12.5px
    fontWeight: 550
    lineHeight: 1.3
    letterSpacing: 0px
  data-md:
    fontFamily: "Overpass Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: 12.5px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0px
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  shell-gutter: 28px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 36px
  nav-active:
    backgroundColor: "{colors.sidebar-raised}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
  input-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: 40px
---

# Chimera++ Design System

## Overview

Chimera++ is a precision desktop utility, not a consumer dashboard. The visual experience should feel intentional from the first second: calm light liquid-glass surfaces, confident typography, selective forest-green (`#1f6a4a`) actions, and crisp state changes. The reference composition is a connection console: users should immediately recognize what Codex is using, whether it is healthy, and what they can change.

Use a light sage-tinted workspace (`#f3f7f4`) and a translucent light liquid-glass navigation rail (`232px`). The color accent is a signal, not decoration. Keep the interface dense enough for repeated work, but give the current connection and its next action enough space to be read at a glance. Avoid loud gradients, neon ornaments, and generic metric-card grids.

## Colors

- **Canvas:** `canvas` is a cool sage-tinted neutral workspace background (`#f3f7f4`). It provides separation without making every region a card.
- **Surfaces:** `surface` and `surface-raised` create a maximum of three tonal layers. Use hairline borders (`--v3-hairline`) where they explain containment or interaction.
- **Forest-green accent:** `accent` (`#1f6a4a`) identifies the one primary action on a screen, the active provider route, and key focus states. Destructive actions use semantic danger red (`--danger-fg`/`--danger-bg`).
- **Semantic states:** success is green, warning is amber, error is red. Status text and icons must accompany color.
- **Sidebar:** translucent light glass (`--sidebar-bg`, `232px` via `--size-sidebar`) is structural, not a second brand color. Selected navigation uses a subtle tonal fill; do not use a glow.

## Typography

Bundled offline variable fonts (`Overpass`, `Noto Sans SC`, and `Overpass Mono`) provide consistent cross-platform rendering without any runtime CDN or system-font dependency. Reserve the monospace face (`Overpass Mono`) for URLs, model IDs, versions, token fingerprints, file paths, and diagnostic output.

Page titles use `title-lg`; panel titles use `title-md`. Labels, button text, and navigation all use `label-md`. Body copy uses `body-md` or `body-sm`. Avoid uppercase English section kickers and wide tracking; Chinese interface labels should stay compact and natural.

## Layout

The v3 desktop shell combines a persistent `232px` light liquid-glass sidebar (`--size-sidebar: 232px`, `aside.chimera-sidebar`), a `52px` top titlebar (`--size-titlebar: 52px`) with breadcrumb context, global search (`Ctrl+K`), and native window controls, and a scrollable light liquid-glass workspace (`section.chimera-content`). Full-screen overlay panels (`FullScreenPanel`) start below the `52px` titlebar (`top-[var(--size-titlebar,52px)]`) so window dragging and window controls remain accessible at all times.

The window itself is frameless with a 1px structural edge ring separating the app from the desktop. Within the sidebar, the tool switcher popover switches between Codex and enabled multi-tools, the middle workspace/local sections support keyboard arrow navigation, and global destinations (`会话` and `设置`) remain anchored at the bottom of the rail.

## Elevation & Depth

Surfaces use the v3 Light Liquid Glass tokens (`--v3-glass-fill`, `--v3-hairline`, `--v3-shadow-inner-top`, `--v3-shadow-outer`) over the sage-tinted neutral canvas. Solid or high-opacity backings keep text legible at WCAG 2.2 AA contrast. Sheets, menus, and dialogs use crisp hairline borders and restrained elevation.

## Shapes

The radius scale uses `6px`–`8px` for compact controls and badges, `10px`–`14px` for cards, signboards, and dialogs, and `16px` for the window shell. Windows window controls sit at the top right (and macOS controls at the top left on macOS) and operate the real Tauri window.

## Components

- **Station signboard (`StationSignboard`):** displays the active Codex route, provider badge, model, endpoint latency, runtime status, 10-minute switch undo bar, and primary launch/restart action. (The historical v2.3 `RouteGlobe` has been retired.)
- **Provider line table (`ProviderLineTable`):** lists configured routes with search, one-click switch, inline latency test, and route manager dialog.
- **Official account cards (`OfficialAccountsView`, `ClaudeAccountsCard`):** manage multiple ChatGPT and Claude accounts with quota progress bars, tags, groups, notes, and relogin indicators.
- **Buttons:** primary uses forest-green `--btn-primary-bg`; secondary is bordered light surface; tertiary is icon-only with a tooltip; destructive actions use danger red. Every button has default, hover, pressed, focus, disabled, loading, and error recovery states.
- **Inputs:** labels stay above inputs. URL, key, and model fields have clear helper text. Key reveal, model picker, folder picker, and test connection use familiar icon actions with tooltips.
- **Segmented controls:** use for stable versus portable distribution and automatic versus manual update source. They do not resize on selection.
- **Tool rows:** health scan, backup, import/export, and open-folder actions use a title, one concise explanation, current status, and an icon action.
- **Dialogs and sheets:** destructive maintenance actions always show scope, consequence, and an explicit confirm action. Configuration forms prefer a right-side sheet or inline inspector over a modal stack.
- **Empty states:** teach the next useful action in one sentence and one command. Do not use decorative illustrations or numbered marketing steps.

## Motion

Motion is a first-class interaction contract. It is short, physical, and tied to state. Default easing is `cubic-bezier(0.22, 1, 0.36, 1)`; never use bounce or elastic easing. Respect `prefers-reduced-motion` by reducing motion to an instant or 100ms opacity transition.

| Event | Motion | Duration |
| --- | --- | --- |
| Page switch | Content crossfade with 8px vertical settle; sidebar stays fixed | 180ms |
| Provider selection | Selected row gains tonal fill; inspector crossfades and settles 4px | 180ms |
| Connection test | Button label becomes progress state; status dot pulses once only while pending | 160ms in, state-driven |
| Successful save | Inline success line fades and a checkmark draws once | 220ms |
| Failed action | Error block expands from its trigger; focus moves to recovery action | 180ms |
| Download/update | Determinate progress bar advances continuously; stage text changes without layout shift | state-driven |
| Dialog/sheet | Backdrop fades; surface translates 8px and fades in | 180ms |
| Skin selection | List selection changes immediately; preview crossfades without scrolling the inspector | 200ms |

No page-load choreography, looping glows, parallax, or universal staggered entrances. Animations must never hide essential content before they run.

## Do's and Don'ts

- Do show the active provider and model before secondary configuration.
- Do use one clear primary action per screen and keep the rest visually quiet.
- Do maintain 4.5:1 contrast for normal text and a visible keyboard focus ring.
- Do make loading, success, error, and disabled states explicit in the design before implementation.
- Don't build screens from repeated same-size metric cards.
- Don't use upstream author names, sponsor marks, provider advertising, or repository labels in the customer interface.
- Don't hide expert settings, but don't put them in the beginner flow.
- Don't use fake macOS controls, loud gradient page backgrounds, or decorative neon glows.
- Don't make a full page scroll just to change a skin or switch a provider.
