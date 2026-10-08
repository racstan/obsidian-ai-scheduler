# Changelog

All notable changes to **AI Scheduler** (`obsidian-ai-scheduler`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.19] - 2026-10-08

### Highlights
- **Calendar export**: keep an `.ics` file of upcoming runs up to date and import it into Google Calendar, Outlook or Apple Calendar (Settings → Calendar export, or the *Export schedule to calendar file (.ics)* command). One-way; nothing is sent anywhere.
- **Result folder picker**: type a path or pick any folder (subfolders included) from a dropdown in the planner, the task editor and settings.
- **Better @ mentions**: `@` now finds folders as well as notes and files, and `[[links]]` in prompts are highlighted.
- **Theme-aware sizing**: text sizes and corner rounding follow your Obsidian appearance settings and theme.

### Changed
- "Default result folder" is now "Result folder"; the plugin-wide default stays in settings.
- Form fields no longer show a hover tooltip that repeats their label.

### Fixed
- Plugin description no longer mentions "Obsidian" (required by the plugin review).

## [2.1.17] - 2026-10-08

Versioning returns to [Semantic Versioning](https://semver.org/) (`x.y.z`), which the Obsidian plugin review requires. 2.1.17 is newer than every earlier release, including 2.1.7.x.

### Highlights
- **Schedules keep their settings**: day of month, month, every-N days/weeks/months and start dates are no longer lost when Obsidian restarts.
- **Safer AI follow-ups**: tasks the AI proposes in its replies are created disabled for you to review, and task output never overwrites notes the plugin did not create (or writes into hidden/`.obsidian` folders).
- **Calendar fixes**: "New task" saves correctly, "Run now" runs recurring tasks, and past runs show as completed only when they actually ran.
- **Real cancellation**: resetting a running task stops Claudian or Copilot instead of letting it continue in the background.

### Added
- Each run without a fixed file name writes its own note (`<timestamp> <task title>.md`).
- Event-triggered tasks are told which file changed.
- Keyboard and screen-reader support for badges, calendar days, chips and file rows.
- Respects the system "reduce motion" setting.

### Changed
- Periodic reviews cover everything changed since the previous review and skip the plugin's own folders.
- Startup catch-up and vault listeners start once Obsidian's layout is ready.
- Missed tasks after the computer sleeps follow the same catch-up rules as a restart.
- Requests to Claudian/Copilot run one at a time.
- Dashboard and calendar refresh only when something changes and keep your scroll position.
- Colours follow your Obsidian theme; the production bundle is minified.
- `main.js` is no longer committed; it is built by CI and shipped as a release asset.

### Fixed
- Daylight-saving bugs in cron and every-N-days/weeks schedules (including a re-run loop on the night clocks go back).
- Edits to schedule notes being reverted, and moved schedule notes being recreated.
- The periodic review not using its own model setting.
- Pausing/resuming from the calendar firing past-due runs immediately.
- Periodic review rescheduling itself on every restart.
- Removed the remaining `!important` CSS rules and an unused import flagged by the plugin review.

## [2.1.7.19] - 2026-10-07

### Changed
- Streamlined the calendar Day View and removed duplicate headers.

### Fixed
- Fixed the layout of the calendar navigation buttons.

## [2.1.7.18] - 2026-10-07

### Added
- Added a full-page Day View to the schedule calendar with a timeline breakdown, metric counters and back navigation.

## [2.1.7.17] - 2026-10-07

### Highlights
- **Fixed Calendar Grid**: Rebuilt the month calendar grid with rigid `minmax(0, 1fr)` 7-column tracks, fixed-height date windows, and expanded modal geometry to eliminate column distortion.
- **Scrollable Day Task Window**: Each day cell provides an internal scrollable list of tasks, letting you view multiple tasks cleanly without distorting the layout.
- **Completed Task Strikethrough**: Completed and past tasks remain permanently on the calendar, marked with a strikethrough and checkmark badge.
- **Periodic Review Refactor**: Refactored Nightly Review into Periodic Review with custom cadences (Daily, Weekly, Every N days, Hourly) and a computer sleep/power notice.
- **Default Periodic Review Folder**: Review summaries automatically route to `<Default Folder>/Periodic Reviews` (e.g. `AI Scheduler/Periodic Reviews`).

### Added
- Added internal vertical scrollbars for day cells with multiple tasks in the calendar month view.
- Added checkmark badge and strikethrough styling for completed tasks across month grid and day timeline panels.
- Added periodic review cadence selector supporting daily, weekly, every N days, and hourly intervals.
- Added computer sleep and power notice banner in review settings.

### Changed
- Expanded calendar modal default width to 1280px (95vw) for high-clarity viewing.
- Refactored nightly review commands and settings to Periodic AI Review.
- Defaulted review output directory to `<Default Folder>/Periodic Reviews`.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.16] - 2026-10-07

### Highlights
- **Schedule Calendar View**: Added an interactive Month Grid and Day Timeline view with status chips, filtering, and instant task actions.
- **Default Task Output Folder**: Unspecified output destinations now automatically route to a configurable default vault folder (defaults to "AI Scheduler").
- **Centralized Task Activity Logging**: Track task runs in a clean Markdown table with serial numbers, timestamps, status, and wikilinks to modified files.
- **PolyForm Noncommercial 1.0.0 License**: Upgraded license terms to PolyForm Noncommercial 1.0.0.
- **Task Trash & Restoration**: Safely recover deleted tasks from a dedicated trash section or with the restore command.

### Added
- Added interactive Schedule Calendar modal with Month Grid and Day Timeline modes.
- Added "AI Scheduler: Open schedule calendar" command to the command palette and a calendar button in the dashboard.
- Added Default Output Folder setting with automatic fallback to "AI Scheduler".
- Added Task Activity Logging setting that writes structured Markdown table entries to "AI SCHEDULER LOGS.md".
- Added Deleted Tasks trash section with Restore, Restore all, and Delete forever controls.
- Added "AI Scheduler: Restore last deleted task" command.

### Changed
- Updated license to PolyForm Noncommercial License 1.0.0.
- Cleaned branding, removed legacy BRAT references and external donation buttons.
- Updated author attributions to @racstan GitHub profile.
- Updated README documentation with clean Obsidian Copilot and Claudian setup guides.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.14] - 2026-10-03

### Highlights
- **Rich Scheduling Cadences**: Added native support for "every N days", "every N weeks", "every N months", and "yearly / every year".
- **Bounded Execution (For N Times)**: Added "Stop after N runs" across all recurring, interval, and cron schedules so tasks finish automatically after N executions.
- **Initial Starting Time & Date**: Configurable starting time (HH:MM) and starting date (YYYY-MM-DD) for interval and recurring cadences.
- **Red Asterisk & Unspecified Detail Highlights**: Added red asterisk markers (*) on mandatory/unspecified fields and AI doubt callout banners.

### Added
- Added support for every N days, every N weeks, monthly/every N months, and yearly schedules.
- Added initial starting date/time settings for interval and recurring schedules.
- Added red asterisk (*) styling on required form labels and doubt badges for unspecified parameters.

### Changed
- Expanded `JobModal` schedule editor with dedicated cadence controls and validation.
- Enhanced AI Planning Note cards to highlight unmentioned prompt parameters with default values.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.13] - 2026-10-03

### Highlights
- **Dedicated Edit Modes (Manual / AI)**: Added intuitive segmented switcher tabs in the Edit dialog allowing instant switching between manual schedule tweaking and AI-assisted rewriting.
- **Fixed Empty Prompt/Instructions Textarea**: Resolved DOM textarea binding issue so existing prompt instructions and titles are always accurately populated.
- **Natural Time Parsing & Ambiguity Notes**: Added smart natural shorthand parsing (e.g. "150 today" -> 1:50 PM / 13:50) with AI clarification doubt banners.
- **Optimized Recent Activity Window**: Capped recent activity to latest 10 entries to maximize dashboard rendering performance.

### Added
- Added segmented tab switcher in `JobModal` for "Edit manually" vs "Edit with AI".
- Added doubt and clarification tracking for AI-planned tasks with visual callouts and notifications.

### Changed
- Explicitly bound value properties to textarea and input fields in `JobModal`.
- Limited Recent Activity feed to the 10 most recent entries.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.12] - 2026-10-03

### Highlights
- **Fixed Scrollable Past Tasks Window**: Past tasks are now presented in a clean, fixed-height scrollable window that prevents vertical overflow.
- **Background Planning State & Visibility**: Added live state tracking (`isPlanning`, `activePlanningGoal`), an interactive banner in the dashboard, and a status bar indicator while AI generates a schedule plan.
- **Past-Due Warning & Modal**: When re-enabling a disabled task whose scheduled run time has passed, a modal prompts to "Run now", "Edit schedule", or keep disabled.
- **Clickable Task IDs in Recent Activity**: Activity log entries now display clickable Task ID badges linking directly to task details and vault file navigation.
- **Streamlined Button UI**: Removed emojis from action buttons for a cleaner, native Obsidian appearance.

### Added
- Added `PastDuePromptModal` for managing tasks enabled after their scheduled time slot has passed.
- Added background planning indicators in the dashboard modal and the status bar.
- Added interactive Task ID click navigation in the Recent Activity log.

### Changed
- Wrapped Past Tasks list in a fixed-height scrollable container.
- Cleaned button labels across all modals and pickers.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.11] - 2026-10-03

### Highlights
- **Past Tasks Inspection View**: Replaced the "Edit" action with a comprehensive "View" modal for completed and past scheduled jobs.
- **Interactive Vault File Navigation**: Instantly view and click to open any file created, modified, synced, or referenced by the task.
- **Artifact & Output Tracking**: Automatically tracks primary output files and generated markdown paths with existence and modification checks.
- **Full Execution Logs & Response Viewer**: Complete prompt preview and AI response inspector with 1-click clipboard copying.

### Added
- Added `TaskViewModal` with file metadata (size, timestamps, badges) and 1-click vault navigation.
- Added `lastOutputPath` and `lastOutputFiles` tracking to `Job` interface and settings persistence.

### Changed
- Replaced `Edit` button on past task cards with `View` button in `AssistantModal`.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.10] - 2026-10-03

### Highlights
- **Obsidian Community Review Compliance**: Resolved all automated validation errors, warnings, and guidelines for official Obsidian plugin distribution.
- **Strict Semantic Versioning**: Standardized plugin and manifest versions on 3-part SemVer (`2.1.8`).
- **Cryptographic Release Attestations**: Added automated GitHub Actions build provenance attestations for `main.js`, `manifest.json`, and `styles.css`.
- **UI & CSS Standards**: Replaced all `!important` CSS rules with specific selectors, adapted UI sentence casing, and standardized setting headers.

### Changed
- Replaced direct `element.style` modifications and `document.createElement` in `@` mention suggest with Obsidian DOM helpers and dedicated CSS classes.
- Updated release workflows with build provenance generation via `actions/attest-build-provenance@v2`.

### Fixed
- Fixed unhandled floating promises on Task ID clipboard copy buttons across all modal dialogues.
- Fixed async callback returns in confirmation dialogs.
- Fixed stringification type warnings across backend error handlers.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.9] - 2026-10-02

### Highlights
- **About AI Scheduler Section**: Added a dedicated project overview, author credits, and GNU GPL-3.0 licensing in plugin Settings.
- **Documentation & Links**: Enriched repository documentation and project metadata.

### Added
- Dedicated "About" section in Settings tab with version info, author metadata, and repository links.
- Documentation updates in project README.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.8] - 2026-10-02

### Highlights
- **Task ID Badges & One-Click Copy**: Every scheduled, running, disabled, and past task card now includes an explicit Task ID badge (`ID: job-xxx`) with instant click-to-copy support.
- **Action Confirmations**: Added confirmation dialogs when clicking "Run again", "▶️ Run now", and "⏹️ Reset / Stop" to give clear visibility and control before executing.
- **Smart Timeout & Error Inspection**: Reduced background AI execution timeout to 10 minutes (down from 30m) with live Claudian error state detection.
- **Live Elapsed Time**: Running tasks display the exact elapsed duration (`Xm Ys elapsed`) next to the execution start time.

### Added
- Interactive Task ID badges with clipboard copy feedback.
- Confirmation dialogs for "Run again", "▶️ Run now", and "⏹️ Reset / Stop".
- Live running duration counter.

### Fixed
- Prevented long background stalls by shortening agent execution timeout and inspecting tab errors.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.7] - 2026-10-02

### Highlights
- **Always-Visible Changelog Actions**: Fixed changelog modal layout using structured flexbox so "Got it" and "⭐ Star on GitHub" remain permanently pinned at the bottom without requiring vertical scrolling.
- **Isolated Scroll Container**: Release notes scroll cleanly in the middle while header, tabs, and footer stay anchored.

### Fixed
- Fixed changelog dialog footer getting cut off on lower-height viewports.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.6] - 2026-10-02

### Highlights
- **Zero Modal Stacking**: Fixed layered window stacking across Dashboard, Planner, and Job Editor with clean single-window lifecycle management.
- **Live Background Execution Indicators**: Prominent glowing "⚡ Running now..." badges, started timestamps, and real-time dashboard auto-refresh.
- **Instant "Run Now" & "Reset/Stop" Controls**: Manually trigger any scheduled task immediately or reset long-running background tasks.
- **Detailed Activity Badges**: Color-coded status badges for running, completed, failed, planned, and reset activities.

### Added
- Live running badges with pulsating glow and spinner for active background tasks.
- Instant "▶️ Run now" button on scheduled tasks.
- Direct "⏹️ Reset / Stop" button for active background jobs.
- Automated 3-second live refresh on open dashboard modals.
- Color-coded activity log tags and start-of-execution activity logging.

### Fixed
- Fixed modal stacking and dual close button layering across all dialogs.
- Fixed misleading "Next run: <past time>" timestamp during background execution.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.5] - 2026-10-02

### Highlights
- **Animated AI Planning Indicator**: Added a pulsing glowing card with animated spinner and live progress messaging while the AI generates scheduled tasks.
- **Interactive Multi-Job Review & Editing**: Directly edit, re-configure with AI, or discard individual planned tasks right from the AI Planner review view.
- **Discard & Discard All Controls**: One-click discarding of unwanted or duplicate planned tasks before leaving the planner.
- **One-Time Schedule Description Fix**: Fixed display of one-time (`once`) schedules showing "not scheduled" instead of their scheduled execution time.
- **Editable Task Details in Editor**: Direct manual editing of task title and prompt alongside AI-driven refinements.

### Added
- Animated loading card and spinner during AI plan generation.
- Per-task `✏️ Edit` and `🗑️ Discard` buttons in the Planner results view.
- Global `🗑️ Discard all` action to clean up all planned tasks in one click.
- Direct Title and Prompt editing fields in the Task Editor modal with `@` mention support.

### Fixed
- Fixed `describeSchedule()` displaying "not scheduled" for one-time execution jobs.

### Contributors
- [@racstan](https://github.com/racstan)

---

## [2.1.7.4] - 2026-10-02

### Highlights
- **Prompt @ Mentions Autocomplete**: Type "@" in any planning or editing prompt to quickly search and attach vault notes directly.
- **Modern Context & Attachments UI**: Replaced legacy multi-select with interactive visual tag chips and native fuzzy file/folder attachment modals.
- **Seamless Modal Navigation**: Added "← Back to dashboard" navigation buttons inside AI Planner and Task Editor modals.
- **Self-Contained Task Directories**: Each schedule note is organized with dedicated task folders and attachment directories.

### Added
- Interactive "@" mention autocomplete dropdown for vault files in prompt textareas.
- Native FuzzySuggest modals for attaching individual files, active notes, and vault folders.
- Top header back button to easily navigate between Planner/Editor and the Dashboard.
- Dedicated attachments folder structure for scheduled tasks.

### Changed
- Removed "Recommended" tag from Claudian backend dropdown for neutral backend selection.
- Eliminated multi-select box hover selection bugs with modern tag chips.

### Contributors
- [@racstan](https://github.com/racstan)

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
- [@racstan](https://github.com/racstan)

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
- [@racstan](https://github.com/racstan)

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
- [@racstan](https://github.com/racstan)

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
- [@racstan](https://github.com/racstan)

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
- [@racstan](https://github.com/racstan)
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
