# Changelog

All notable changes to **AI Scheduler** (`obsidian-ai-scheduler`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.7.3] - 2026-10-02

### Highlights
- **Reliable Changelog Lifecycle**: Release notes display strictly once per update on normal workspace startup, never interrupting settings navigation or reloads.
- **Zero-Task Edge Case Handling**: Clean feedback notification ("No tasks available") when bulk enabling, disabling, or deleting with an empty list.
- **Conditional Reviews Section**: Daily & Nightly Review settings dynamically hide when no AI backend is active.
- **Comprehensive Nightly Review Documentation**: Enhanced explanations of autonomous end-of-day synthesis and timestamped vault report storage.

### Added
- Zero-task guard and toast notices across dashboard bulk actions and command palette.
- Layout-ready event scheduling for update changelog modals.

### Changed
- Daily & Nightly Reviews settings section only renders when Claudian or Copilot backend is active.
- Enriched descriptions for Nightly AI Review explaining nightly synthesis and timestamped note archives.

### Contributors
- [@racstan](https://github.com/racstan) (Rachit Asthana)

---

## [2.1.7.2] - 2026-10-02

### Highlights
- **Native Desktop / System Notifications**: Real OS desktop notifications on Windows, macOS, and Linux when tasks complete or fail.
- **Bulk Actions Confirmation & Feedback**: "Enable all" now requires confirmation, and bulk enable/disable/delete actions display exact count toasts.
- **Enhanced Notifications Settings**: Dedicated toggles for in-app notices, system desktop notifications, and a full testing utility.

### Added
- Native desktop notification integration using the Web/Electron Notification API.
- Confirmation dialog before enabling all scheduled tasks in bulk.
- Exact task count notifications when enabling, disabling, or deleting tasks.
- System desktop notifications toggle under Background Execution & Notifications settings.

### Changed
- Test notification button now triggers both in-app and system desktop alerts to verify OS permissions.

### Contributors
- [@racstan](https://github.com/racstan) (Rachit Asthana)

---

## [2.1.7.1] - 2026-10-02

### Highlights
- **Dynamic AI Backend Configuration**: Unconfigured/None mode with clear guidance and conditional model visibility.
- **Categorized Settings**: Clean visual sections for AI Backend, Execution & Reliability, Reviews, and Markdown Sync.
- **Per-Task Next Run Visibility**: Explicit next run timestamps displayed on each task card.
- **Theme & Modal Fixes**: Seamless dark/light theme styling and modal stability fixes.

### Added
- Default unselected placeholder in AI backend dropdown ("Select an AI backend...").
- Per-task next run indicator in dashboard cards and scheduled task list.
- Categorized settings layout with intuitive section headers and descriptions.

### Changed
- Backend model pickers dynamically show or hide based on the active backend.
- Refined dark and light mode contrast across all modal views.

### Fixed
- Fixed DOM class token parsing exceptions in Planner and Job modals.
- Fixed ambiguous dashboard next run stat clarity.

### Contributors
- [@racstan](https://github.com/racstan) (Rachit Asthana)

---

## [2.1.7] - 2026-09-30

### Highlights
- **Redesigned AI Planner**: Clean, unstacked dialog with direct prompt-first goal input and spacious responsive layout.
- **Backend Readiness Alerts**: Prominent warning banner when AI backend or models are unconfigured with 1-click navigation to Settings.
- **Fixed Scrollable Activity Window**: Encapsulated recent activity logs into a fixed-height scrollable window.
- **Streamlined Dashboard**: Added a direct Settings button and moved on-demand review actions to the Settings tab.

### Added
- Direct "Open settings" button in the main AI Scheduler dashboard header.
- Backend configuration check and warning banner on dashboard, planner, and job editor.
- Dedicated "Daily & nightly reviews" section in Settings with instant preview and review buttons.

### Fixed
- Fixed modal stacking behavior when opening the AI Planner from the dashboard.
- Fixed modal sizing and layout clipping across planner and task editor modals.
- Fixed YAML frontmatter delimiter formatting and note cleanup on task deletion.
- Fixed cron multi-time conversion and range stepping math.

### Contributors
- [@racstan](https://github.com/racstan) (Rachit Asthana)

---

## [2.1.6] - 2026-09-30

### Highlights
- **In-App Interactive Changelog**: AI Scheduler now highlights new features, improvements, and fixes after every release with a toggleable modal and full release history.
- **GNU General Public License v3.0 (GPL-3.0)**: Upgraded plugin license with mandatory author attribution, copyleft share-alike terms, and strong open-source guarantees.
- **Event Queueing Architecture**: Vault change events fired during ongoing task executions are now safely queued and processed instead of dropped.
- **Obsidian Default Export Compatibility**: Fixed plugin loader failure on Obsidian initialization.

### Added
- Interactive "What's new" modal dialog displaying current update highlights, full timeline history, and a "Never show again" preference toggle.
- `AI Scheduler: View changelog / what's new` command palette action and Settings tab button.
- User preference toggle in settings for automatic post-update changelog dialogs.
- Community help & issue reporter shortcut directly in Settings (`Facing a problem?`).

### Fixed
- **Plugin Constructor Loading Failure**: Added default CommonJS export compatibility for Obsidian's plugin loader (Thanks to [@leweii](https://github.com/leweii) in PR [#2](https://github.com/racstan/obsidian-ai-scheduler/pull/2) for reporting and contributing the fix!).
- Prevented timer memory leaks by clearing background timeout handles upon AI completion.
- Fixed file collision when writing reports/outputs to a path matching an existing vault folder name.
- Sanitized review context folder trailing slashes to avoid unintended note exclusions.
- Hardened follow-up task creation with schema validation and 100-job max bounds.
- Wrapped plugin state persistence in comprehensive error handling.

### Contributors
- [@racstan](https://github.com/racstan) (Rachit Asthana)
- [@leweii](https://github.com/leweii) (Jakob He - PR [#2](https://github.com/racstan/obsidian-ai-scheduler/pull/2))

---

## [2.1.5] - 2026-09-30

### Highlights
- **Critical Stability & Validation Hardening**: Resolved background timeout memory leaks and enforced strict validation schemas on AI-generated follow-up plans.

### Fixed
- Cleared active timers in AI communication handlers upon completion.
- Added total job limit guardrail (max 100) to prevent unbounded recursive self-talk.
- Hardened vault state writes with comprehensive try-catch wrappers.
- Validated context paths before sending planning prompts.

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
