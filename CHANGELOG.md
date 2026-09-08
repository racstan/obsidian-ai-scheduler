# Changelog

All notable changes to **AI Scheduler** (`obsidian-ai-scheduler`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.4] - 2026-09-08

### Fixed
- **Manifest Description Compliance**: Removed redundant "Obsidian" reference from plugin description in `manifest.json` in accordance with Obsidian Community Plugin review guidelines.

---

## [2.1.3] - 2026-09-06

### Highlights
- **100% Strict TypeScript Integration Bridges**: Fully eliminated `@typescript-eslint/no-explicit-any` directives across the backend integration layer. Claudian and Obsidian Copilot internals are now mapped with rigorous TypeScript typings.
- **Obsidian Official Review Ready**: Zero ESLint warnings or rule suppressions under the official `eslint-plugin-obsidianmd` standard ruleset.
- **Refined Settings & UI Lifecycles**: Replaced deprecated `display()` re-invocation patterns with decoupled `renderSettings()` execution, eliminating Obsidian deprecation notices.
- **Hardened Input Sanitization**: Safe parsing and validation for clock inputs and task configurations.

### Added
- Comprehensive bridge interface definitions for Claudian (`ClaudianPlugin`, `ClaudianView`, `ClaudianTabRecord`, `ClaudianConversation`, `ClaudianProviderInfo`) and Obsidian Copilot (`CopilotPlugin`, `CopilotApp`, `CopilotQAChain`, `CopilotPromptChain`).
- Type-safe profile parsers (`parseProfileValue`) and tab resolution helpers (`getTab`) to safeguard against missing or reconfigured assistant contexts.

### Changed
- Refactored `AssistantSettingTab` to decouple settings re-rendering from `PluginSettingTab.prototype.display()`, preventing lifecycle re-entry warnings.
- Updated `PlannerModal` UI copy to adhere to standard Obsidian sentence-case conventions (`AI Planner`, clean concise action labels).
- Enhanced `package.json` and `manifest.json` descriptions to clearly articulate the unique value proposition: the first and only autonomous background scheduling engine for Obsidian.

### Fixed
- Fixed unhandled type coercion in `schedule.ts` (`parseClock` and `validClock`) when encountering non-string or numeric clock values.
- Resolved all remaining linter warnings across `src/backends.ts`, `src/schedule.ts`, `src/ui/PlannerModal.ts`, and `src/ui/SettingsTab.ts`.

---

## [2.1.2] - 2026-09-06

### Added
- **Native Accessible Confirmations (`ConfirmModal`)**: Replaced browser `window.confirm` dialogs with native Obsidian modal dialogs for all destructive actions (individual task deletion, bulk disable all, bulk delete all), fully complying with Obsidian plugin review guidelines.
- Stubbed declarative setting definitions (`getSettingDefinitions()`) in `AssistantSettingTab` for forward compatibility with Obsidian settings infrastructure.

### Fixed
- Hardened multi-rule JSON deserialization (`parseMultiRulesText`) in `schedule.ts` with safe unknown type assertions.
- Improved clock string regex matching to prevent crashes on edge-case inputs.

---

## [2.1.1] - 2026-09-05

### Highlights
- **Zero-Dependency 5-Field Cron Scheduling Engine**: Integrated a pure, dependency-free cron evaluation engine bundled directly into the plugin source (adapted from `cron-parser`).
- **Two-Way Synced Schedule Notes**: Every scheduled task can optionally be mirrored to a Markdown note in your vault (`AI Schedules/`). Edit the frontmatter in Obsidian or tweak the modal UI—both stay in perfect lockstep.

### Added
- Full 5-field cron expression support (`minute hour day-of-month month day-of-week`) with live keystroke validation and next-run previews.
- DST-safe scheduling arithmetic: properly skips non-existent spring-forward wall times and avoids double-firing during fall-back transitions.
- Markdown frontmatter parser and synchronizer (`notes.ts`) with automated table rendering of task cadences.
- Resilient startup catch-up engine: automatically evaluates jobs that fell due while Obsidian was closed (configurable catch-up window).
- Run recovery mechanism: gracefully resets tasks that were interrupted by an app exit or system reboot.

### Changed
- Rebuilt entire plugin core from modular TypeScript sources with esbuild bundling.
- Added comprehensive unit test suite covering cron math, schedule normalization, and execution state machines.

---

## [2.1.0] - 2026-08-22

### Added
- **Dual Backend Architecture**: Added native support for [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) alongside [Claudian](https://github.com/YishenTu/claudian). Switch seamlessly between backends in settings.
- **Interval Schedules**: Run jobs every *N* minutes or *N* hours with optional bounded iteration limits (e.g., "run every 30 minutes for 8 iterations").
- **Task Context Binding**: Attach active notes or entire vault project folders to any scheduled task so the AI receives fresh, relevant vault context on every run.
- **Custom Output Routing**: Route outputs and reports generated by specific tasks directly into dedicated vault folders.

---

## [2.0.4] - 2026-08-22

### Added
- Automated GitHub Actions release pipeline with asset provenance verification.
- Smoke testing harness (`scripts/run-smoke.mjs`) to test the compiled plugin bundle against a mock Obsidian API runtime.

---

## [2.0.3] - 2026-08-22

### Changed
- Redesigned assistant task dashboard with organized categories: **Active Scheduled Tasks**, **Disabled Tasks**, and **Past Completed Tasks**.
- Added task serial numbers (`#1`, `#2`, etc.) and visual badges distinguishing **Independent** vs. **Project-based** contextual tasks.

---

## [2.0.2] - 2026-08-22

### Added
- **Multi-Model Routing Profiles**: Configure separate Claudian models for Planning, Scheduled Task Execution, Daily Previews, and Nightly Reviews.
- Live model refresher button in settings to pull newly added provider models without restarting Obsidian.

---

## [2.0.1] - 2026-08-21

### Fixed
- Fixed Claudian conversation persistence and session lifecycle management.
- Standardized plugin identifier, CSS namespace, and event logging under `ai-scheduler`.

---

## [2.0.0] - 2026-08-21

### Highlights
- Initial release of **AI Scheduler** for Obsidian: bringing autonomous, scheduled, and proactive background AI execution to personal knowledge graphs.
