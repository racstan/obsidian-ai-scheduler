/*
 * AI Scheduler Changelog Data
 * Maintained history of releases from 2.0.0 to current.
 */

export interface Contributor {
	name: string;
	username?: string;
	url: string;
	role?: string;
}

export interface ReleaseChangelog {
	version: string;
	date: string;
	title: string;
	highlights?: string[];
	added?: string[];
	changed?: string[];
	fixed?: string[];
	contributors?: Contributor[];
}

export const CHANGELOG_DATA: ReleaseChangelog[] = [
	{
		version: '2.1.18',
		date: '2026-10-08',
		title: 'Folder Picker, Linked Mentions & Theme-Aware Sizing',
		highlights: [
			'Result folder: type a path or pick any folder (subfolders included) from a dropdown in the planner, the task editor and settings.',
			'@ mentions now find folders as well as notes and files, and [[links]] in prompts are highlighted.',
			'Text sizes and corner rounding follow your Obsidian appearance settings and theme.',
		],
		changed: [
			'"Default result folder" is now "Result folder"; the plugin-wide default stays in settings.',
			'Form fields no longer show a hover tooltip that repeats their label.',
		],
		fixed: [
			'Plugin description no longer mentions "Obsidian" (required by the plugin review).',
		],
	},
	{
		version: '2.1.17',
		date: '2026-10-08',
		title: 'Reliability, Safety & Accessibility Overhaul',
		highlights: [
			'Schedules keep their settings: day of month, month, every-N days/weeks/months and start dates are no longer lost when Obsidian restarts.',
			'Safer AI follow-ups: tasks the AI proposes in its replies are created disabled for you to review, and task output never overwrites notes the plugin did not create.',
			'Calendar fixes: "New task" saves correctly, "Run now" runs recurring tasks, and past runs show as completed only when they actually ran.',
			'Real cancellation: resetting a running task stops Claudian or Copilot instead of letting it continue in the background.',
			'Versioning returns to semantic versions (2.1.17) so updates are offered to everyone.',
		],
		added: [
			'Each run without a fixed file name writes its own note ("<timestamp> <task title>.md").',
			'Event-triggered tasks are told which file changed.',
			'Keyboard and screen-reader support for badges, calendar days, chips and file rows.',
			'Respects the system "reduce motion" setting.',
		],
		changed: [
			'Periodic reviews cover everything changed since the previous review and skip the plugin\'s own folders.',
			'Startup catch-up and vault listeners start once Obsidian\'s layout is ready, so startup is never held up by an AI run.',
			'Missed tasks after the computer sleeps follow the same catch-up rules as a restart.',
			'Requests to Claudian/Copilot run one at a time.',
			'Dashboard and calendar refresh only when something changes and keep your scroll position.',
			'Colours follow your Obsidian theme; the bundle is minified.',
		],
		fixed: [
			'Daylight-saving bugs in cron and every-N-days/weeks schedules (including a re-run loop on the night clocks go back).',
			'Edits to schedule notes being reverted, and moved schedule notes being recreated.',
			'The periodic review not using its own model setting.',
			'Pausing/resuming from the calendar firing past-due runs immediately.',
			'Periodic review rescheduling itself on every restart.',
			'Removed the remaining !important CSS rules and an unused import flagged by the plugin review.',
		],
	},
	{
		version: '2.1.7.19',
		date: '2026-10-07',
		title: 'Streamlined Calendar Day View',
		changed: [
			'Streamlined the calendar Day View and removed duplicate headers.',
		],
		fixed: [
			'Fixed the layout of the calendar navigation buttons.',
		],
	},
	{
		version: '2.1.7.18',
		date: '2026-10-07',
		title: 'Full-Page Day View in the Schedule Calendar',
		added: [
			'Added a full-page Day View to the schedule calendar with a timeline breakdown, metric counters and back navigation.',
		],
	},
	{
		version: '2.1.7.17',
		date: '2026-10-07',
		title: 'Calendar Layout Overhaul, Completed Task Strikethrough & Periodic Review Refactor',
		highlights: [
			'Fixed Calendar Grid: Rebuilt the month calendar grid with rigid minmax(0, 1fr) 7-column tracks, fixed-height date windows, and expanded modal geometry to eliminate column distortion.',
			'Scrollable Day Task Window: Each day cell provides an internal scrollable list of tasks, letting you view multiple tasks cleanly without distorting the layout.',
			'Completed Task Strikethrough: Completed and past tasks remain permanently on the calendar, marked with a strikethrough and checkmark badge.',
			'Periodic Review Refactor: Refactored Nightly Review into Periodic Review with custom cadences (Daily, Weekly, Every N days, Hourly) and a computer sleep/power notice.',
			'Default Periodic Review Folder: Review summaries automatically route to <Default Folder>/Periodic Reviews (e.g. AI Scheduler/Periodic Reviews).',
		],
		added: [
			'Added internal vertical scrollbars for day cells with multiple tasks in the calendar month view.',
			'Added checkmark badge and strikethrough styling for completed tasks across month grid and day timeline panels.',
			'Added periodic review cadence selector supporting daily, weekly, every N days, and hourly intervals.',
			'Added computer sleep and power notice banner in review settings.',
		],
		changed: [
			'Expanded calendar modal default width to 1280px (95vw) for high-clarity viewing.',
			'Refactored nightly review commands and settings to Periodic AI Review.',
			'Defaulted review output directory to <Default Folder>/Periodic Reviews.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.16',
		date: '2026-10-07',
		title: 'Schedule Calendar View, Default Output Folder, Task Activity Logging & PolyForm License',
		highlights: [
			'Schedule Calendar View: Added an interactive Month Grid and Day Timeline view with status chips, filtering, and instant task actions.',
			'Default Task Output Folder: Unspecified output destinations now automatically route to a configurable default vault folder (defaults to "AI Scheduler").',
			'Centralized Task Activity Logging: Track task runs in a clean Markdown table with serial numbers, timestamps, status, and wikilinks to modified files.',
			'PolyForm Noncommercial 1.0.0 License: Upgraded license terms to PolyForm Noncommercial 1.0.0.',
			'Task Trash & Restoration: Safely recover deleted tasks from a dedicated trash section or with the restore command.',
		],
		added: [
			'Added interactive Schedule Calendar modal with Month Grid and Day Timeline modes.',
			'Added "AI Scheduler: Open schedule calendar" command to the command palette and a calendar button in the dashboard.',
			'Added Default Output Folder setting with automatic fallback to "AI Scheduler".',
			'Added Task Activity Logging setting that writes structured Markdown table entries to "AI SCHEDULER LOGS.md".',
			'Added Deleted Tasks trash section with Restore, Restore all, and Delete forever controls.',
			'Added "AI Scheduler: Restore last deleted task" command.',
		],
		changed: [
			'Updated license to PolyForm Noncommercial License 1.0.0.',
			'Cleaned branding, removed legacy BRAT references and external donation buttons.',
			'Updated author attributions to @racstan GitHub profile.',
			'Updated README documentation with clean Obsidian Copilot and Claudian setup guides.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.14',
		date: '2026-10-03',
		title: 'Rich Cadences (Every N Days/Weeks/Months/Years), Initial Time Anchors & Red Asterisk Highlights',
		highlights: [
			'Rich Scheduling Cadences: Added native support for "every N days", "every N weeks", "every N months", and "yearly / every year".',
			'Bounded Execution (For N Times): Added "Stop after N runs" across all recurring, interval, and cron schedules so tasks finish automatically after N executions.',
			'Initial Starting Time & Date: Configurable starting time (HH:MM) and starting date (YYYY-MM-DD) for interval and recurring cadences.',
			'Red Asterisk & Unspecified Detail Highlights: Added red asterisk markers (*) on mandatory/unspecified fields and AI doubt callout banners.',
		],
		added: [
			'Added support for every N days, every N weeks, monthly/every N months, and yearly schedules.',
			'Added initial starting date/time settings for interval and recurring schedules.',
			'Added red asterisk (*) styling on required form labels and doubt badges for unspecified parameters.',
		],
		changed: [
			'Expanded JobModal schedule editor with dedicated cadence controls and validation.',
			'Enhanced AI Planning Note cards to highlight unmentioned prompt parameters with default values.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.13',
		date: '2026-10-03',
		title: 'Dual Edit Modes (Manual / AI), Textarea Content Binding & Time Shorthand Clarifications',
		highlights: [
			'Dedicated Edit Modes (Manual / AI): Added intuitive segmented switcher tabs in the Edit dialog allowing instant switching between manual tweaking and AI-assisted rewriting.',
			'Fixed Empty Prompt/Instructions Textarea: Resolved DOM textarea binding issue so existing prompt instructions and titles are always accurately populated.',
			'Natural Time Parsing & Ambiguity Notes: Added smart natural shorthand parsing (e.g. "150 today" -> 1:50 PM / 13:50) with AI clarification doubt banners.',
			'Optimized Recent Activity Window: Capped recent activity to latest 10 entries to maximize dashboard rendering performance.',
		],
		added: [
			'Added segmented tab switcher in JobModal for "Edit manually" vs "Edit with AI".',
			'Added doubt and clarification tracking for AI-planned tasks with visual callouts and notifications.',
		],
		changed: [
			'Explicitly bound value properties to textarea and input fields in JobModal.',
			'Limited Recent Activity feed to the 10 most recent entries.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.12',
		date: '2026-10-03',
		title: 'Scrollable Past Tasks, Live Planning Visibility & Past-Due Edge Case Handling',
		highlights: [
			'Fixed Scrollable Past Tasks Window: Past tasks are now constrained to a clean, fixed-height scrollable window.',
			'Background Planning State & Visibility: Live banner in dashboard and status bar when AI is generating a schedule plan.',
			'Past-Due Enable Warning & Action Modal: Prompts to "Run now" or "Edit schedule" when enabling a task whose scheduled time has passed.',
			'Interactive Task IDs in Activity: Clickable Task ID badges in Recent Activity to open task details and file navigation directly.',
			'Streamlined Button UI: Removed emojis from action buttons for a cleaner, native Obsidian appearance.',
		],
		added: [
			'Added PastDuePromptModal for handling tasks whose run time elapsed while disabled.',
			'Added isPlanning and activePlanningGoal background state tracking and status bar indicator.',
			'Added interactive Task ID navigation in Recent Activity log rows.',
		],
		changed: [
			'Wrapped Past Tasks list in a fixed-height scrollable container.',
			'Sanitized action buttons across AssistantModal, PlannerModal, TaskViewModal, and contextPicker.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.11',
		date: '2026-10-03',
		title: 'Past Task View Modal & Vault File Navigation',
		highlights: [
			'Past Tasks Inspection View: Replaced the "Edit" action with a comprehensive "View" modal for completed and past scheduled jobs.',
			'Interactive Vault File Navigation: Instantly view and click to open any file created, modified, synced, or referenced by the task.',
			'Artifact & Output Tracking: Automatically tracks primary output files and generated markdown paths with existence and modification checks.',
			'Full Execution Logs & Response Viewer: Complete prompt preview and AI response inspector with 1-click clipboard copying.',
		],
		added: [
			'Added TaskViewModal with file metadata (size, timestamps, badges) and 1-click vault navigation.',
			'Added lastOutputPath and lastOutputFiles tracking to Job interface and settings persistence.',
		],
		changed: [
			'Replaced Edit button on past task cards with View button in AssistantModal.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.10',
		date: '2026-10-03',
		title: 'Obsidian Review Compliance & Release Attestations',
		highlights: [
			'Obsidian Community Review Compliance: Resolved all automated validation errors, warnings, and guidelines for official Obsidian plugin distribution.',
			'Strict Semantic Versioning: Standardized plugin and manifest versions on 3-part SemVer (2.1.8).',
			'Cryptographic Release Attestations: Added automated GitHub Actions build provenance attestations for main.js, manifest.json, and styles.css.',
			'UI & CSS Standards: Replaced all !important CSS rules with specific selectors, adapted UI sentence casing, and standardized setting headers.',
		],
		changed: [
			'Replaced direct element.style modifications and document.createElement in @ mention suggest with Obsidian DOM helpers and dedicated CSS classes.',
			'Updated release workflows with build provenance generation via actions/attest-build-provenance@v2.',
		],
		fixed: [
			'Fixed unhandled floating promises on Task ID clipboard copy buttons across all modal dialogues.',
			'Fixed async callback returns in confirmation dialogs.',
			'Fixed stringification type warnings across backend error handlers.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.9',
		date: '2026-10-02',
		title: 'About AI Scheduler & Metadata',
		highlights: [
			'About AI Scheduler Section: Added dedicated project overview, author credits, and license details in Settings.',
			'Documentation & Links: Enriched repository documentation and project metadata.',
		],
		added: [
			'Dedicated "About" section in Settings tab with version info, author metadata, and repository links.',
			'Documentation updates in project README.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.8',
		date: '2026-10-02',
		title: 'Task ID Badges, Execution Confirmations & Smart Timeout Protection',
		highlights: [
			'Task ID Display & Copy: Every task card and modal displays a clean ID badge (e.g. ID: job-xxx) that copies to clipboard on click.',
			'Action Confirmations: Added clear confirmation prompts when clicking "Run again", "Run now", or "Reset / Stop" to prevent accidental triggers.',
			'Smart Timeout Protection: Reduced background AI agent timeout to 10 minutes with immediate Claudian tab error detection.',
			'Live Elapsed Duration: Running task status displays real-time elapsed execution timer.',
		],
		added: [
			'Interactive Task ID badges with one-click clipboard copying.',
			'Confirmation dialog on "Run again" for missed/past tasks.',
			'Confirmation dialog on "▶️ Run now" and "⏹️ Reset / Stop".',
			'Real-time elapsed execution duration timer on active tasks.',
		],
		fixed: [
			'Prevented background execution from hanging indefinitely by enforcing 10-minute timeout and live tab error inspection.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.7',
		date: '2026-10-02',
		title: 'Zero-Scroll Changelog Dialog with Always-Visible Action Buttons',
		highlights: [
			'Always-Visible Footer Actions: Pinned "Got it" and "⭐ Star on GitHub" buttons at the bottom of the changelog modal without requiring vertical scrolling.',
			'Isolated Middle Scroll Container: Release notes and version history smoothly scroll in the middle while header, tabs, and actions stay anchored.',
		],
		fixed: [
			'Fixed changelog dialog footer getting cut off by outer viewport height.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.6',
		date: '2026-10-02',
		title: 'Zero Modal Stacking, Live Execution Indicators, Instant Run & Stop Controls',
		highlights: [
			'Zero Window Stacking: Fixed layered modal stacking across Dashboard, Planner, and Job Editor with clean single-window lifecycle management.',
			'Live Running Progress & Badges: Prominent glowing "⚡ Running now..." badges, started timestamps, and real-time dashboard auto-refresh.',
			'Instant "Run Now" & "Reset/Stop" Controls: Manually trigger any scheduled task immediately or reset long-running background tasks.',
			'Detailed Activity Badges: Color-coded status badges for running, completed, failed, planned, and reset activities.',
		],
		added: [
			'Live running badges with pulsating glow and spinner for active background tasks.',
			'Instant "▶️ Run now" button on scheduled tasks.',
			'Direct "⏹️ Reset / Stop" button for active background jobs.',
			'Automated 3-second live refresh on open dashboard modals.',
			'Color-coded activity log tags and start-of-execution activity logging.',
		],
		fixed: [
			'Fixed modal stacking and dual close button layering across all dialogs.',
			'Fixed misleading "Next run: <past time>" timestamp during background execution.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author & Lead Maintainer',
			},
		],
	},
	{
		version: '2.1.7.5',
		date: '2026-10-02',
		title: 'AI Planning Loading Animation, Interactive Plan Review & Direct Task Editing',
		highlights: [
			'AI Planning Loading Animation: Beautiful glowing pulse card and spinner showing real-time feedback while AI generates schedules.',
			'Interactive Planned Tasks Review: Direct "✏️ Edit" and "🗑️ Discard" buttons on each generated task card before finalizing.',
			'Once Schedule Description Fix: Fixed "not scheduled" label bug on one-time scheduled tasks.',
		],
		added: [
			'Pulsing glow and spinner animation during AI plan generation.',
			'Per-task edit and discard controls directly on the AI Planner review screen.',
			'Discard all button on the planning review screen.',
		],
		fixed: [
			'Fixed describeSchedule rendering "not scheduled" for one-time (once) tasks.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.7.4',
		date: '2026-10-02',
		title: 'Prompt @ Mentions, Modern Context Chips, Back Navigation & Task Directory Structure',
		highlights: [
			'Prompt @ Mentions Autocomplete: Type "@" in any planning or editing prompt to quickly search and attach vault notes directly.',
			'Modern Context & Attachments UI: Replaced legacy multi-select with interactive visual tag chips and native fuzzy file/folder attachment modals.',
			'Seamless Modal Navigation: Added "← Back to dashboard" navigation buttons inside AI Planner and Task Editor modals.',
			'Self-Contained Task Directories: Each schedule note is organized with dedicated task folders and attachment directories.',
		],
		added: [
			'Interactive "@" mention autocomplete dropdown for vault files in prompt textareas.',
			'Native FuzzySuggest modals for attaching individual files, active notes, and vault folders.',
			'Top header back button to easily navigate between Planner/Editor and the Dashboard.',
			'Dedicated attachments folder structure for scheduled tasks.',
		],
		changed: [
			'Removed "Recommended" tag from Claudian backend dropdown for neutral backend selection.',
			'Eliminated multi-select box hover selection bugs with modern tag chips.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.7.3',
		date: '2026-10-02',
		title: 'Changelog Lifecycle Polish, Zero-Task Edge Cases & Conditional Review Settings',
		highlights: [
			'Reliable Changelog Lifecycle: Release notes display strictly once per update on normal workspace startup, never interrupting settings navigation or reloads.',
			'Zero-Task Edge Case Handling: Clean feedback notification ("No tasks available") when bulk enabling, disabling, or deleting with an empty list.',
			'Conditional Reviews Section: Daily & Nightly Review settings dynamically hide when no AI backend is active.',
			'Comprehensive Nightly Review Documentation: Enhanced explanations of autonomous end-of-day synthesis and timestamped vault report storage.',
		],
		added: [
			'Zero-task guard and toast notices across dashboard bulk actions and command palette.',
			'Layout-ready event scheduling for update changelog modals.',
		],
		changed: [
			'Daily & Nightly Reviews settings section only renders when Claudian or Copilot backend is active.',
			'Enriched descriptions for Nightly AI Review explaining nightly synthesis and timestamped note archives.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.7.2',
		date: '2026-10-02',
		title: 'Native Desktop Notifications, Bulk Actions Feedback & Confirmations',
		highlights: [
			'Native Desktop / System Notifications: Real OS desktop notifications on Windows, macOS, and Linux when tasks complete or fail.',
			'Bulk Actions Confirmation & Feedback: "Enable all" now requires confirmation, and bulk enable/disable/delete actions display exact count toasts.',
			'Enhanced Notifications Settings: Dedicated toggles for in-app notices, system desktop notifications, and a full testing utility.',
		],
		added: [
			'Native desktop notification integration using the Web/Electron Notification API.',
			'Confirmation dialog before enabling all scheduled tasks in bulk.',
			'Exact task count notifications when enabling, disabling, or deleting tasks.',
			'System desktop notifications toggle under Background Execution & Notifications settings.',
		],
		changed: [
			'Test notification button now triggers both in-app and system desktop alerts to verify OS permissions.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.7.1',
		date: '2026-10-02',
		title: 'Dynamic AI Backend Configuration, Categorized Settings & UI Polish',
		highlights: [
			'Dynamic AI Backend Configuration: Unconfigured/None mode with clear guidance and conditional model visibility.',
			'Categorized Settings: Clean visual sections for AI Backend, Execution & Reliability, Reviews, and Markdown Sync.',
			'Per-Task Next Run Visibility: Explicit next run timestamps displayed on each task card.',
			'Theme & Modal Fixes: Seamless dark/light theme styling and modal stability fixes.',
		],
		added: [
			'Default unselected placeholder in AI backend dropdown ("Select an AI backend...").',
			'Per-task next run indicator in dashboard cards and scheduled task list.',
			'Categorized settings layout with intuitive section headers and descriptions.',
		],
		changed: [
			'Backend model pickers dynamically show or hide based on the active backend.',
			'Refined dark and light mode contrast across all modal views.',
		],
		fixed: [
			'Fixed DOM class token parsing exceptions in Planner and Job modals.',
			'Fixed ambiguous dashboard next run stat clarity.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.7',
		date: '2026-09-30',
		title: 'Planner UI Overhaul, Backend Readiness Alerts & Settings Shortcuts',
		highlights: [
			'Redesigned AI Planner: Clean, unstacked dialog with direct prompt-first goal input and spacious responsive layout.',
			'Backend Readiness Alerts: Prominent warning banner when AI backend or models are unconfigured with 1-click navigation to Settings.',
			'Fixed Scrollable Activity Window: Encapsulated recent activity logs into a fixed-height scrollable window.',
			'Streamlined Dashboard: Added a direct Settings button and moved on-demand review actions to the Settings tab.',
		],
		added: [
			'Direct "Open settings" button in the main AI Scheduler dashboard header.',
			'Backend configuration check and warning banner on dashboard, planner, and job editor.',
			'Dedicated "Daily & nightly reviews" section in Settings with instant preview and review buttons.',
		],
		fixed: [
			'Fixed modal stacking behavior when opening the AI Planner from the dashboard.',
			'Fixed modal sizing and layout clipping across planner and task editor modals.',
			'Fixed YAML frontmatter delimiter formatting and note cleanup on task deletion.',
			'Fixed cron multi-time conversion and range stepping math.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
		],
	},
	{
		version: '2.1.6',
		date: '2026-09-30',
		title: 'In-App Changelog System, Stability Hardening & GPL-3.0',
		highlights: [
			'In-App Changelog System: Automatically shows release notes after plugin updates with full history view and a "never show again" option.',
			'License Upgrade to GNU GPLv3: Strong copyleft protections, author attribution requirements, and open-source guarantees.',
			'Resilient Event Queueing: Vault events fired during active executions are now queued rather than dropped.',
		],
		added: [
			'Interactive What\'s new / changelog modal dialog with complete version timeline.',
			'"AI Scheduler: View changelog / what\'s new" command and Settings button.',
			'Setting toggle to control whether changelogs appear automatically on update.',
			'Community help & issue reporter shortcut directly in Settings.',
		],
		fixed: [
			'Fixed plugin default export compatibility for Obsidian loader (thanks @leweii in PR #2).',
			'Prevented timer memory leaks by clearing timeout handles on AI completions.',
			'Fixed folder collision when writing reports/outputs to a path matching an existing folder.',
			'Sanitized review context folder trailing slashes to prevent accidental file inclusion.',
			'Validated AI-generated task schemas and bounded recursive follow-ups to 100 jobs max.',
			'Added safe error handling around plugin state persistence.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Maintainer',
			},
			{
				name: 'Jakob He',
				username: 'leweii',
				url: 'https://github.com/leweii',
				role: 'Contributor (PR #2)',
			},
		],
	},
	{
		version: '2.1.5',
		date: '2026-09-30',
		title: 'Critical Stability, Memory Leaks & Validation Hardening',
		highlights: [
			'Resolved background timeout leaks during long-running AI requests.',
			'Enforced validation schemas on AI-generated follow-up jobs and schedule plans.',
		],
		fixed: [
			'Cleared active timers in AI communication handlers upon completion.',
			'Added total job limit guardrail (max 100) to prevent unbounded recursive self-talk.',
			'Hardened vault state writes with comprehensive error handling.',
			'Validated context paths before sending planning prompts.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.1.4',
		date: '2026-09-08',
		title: 'Community Plugin Manifest Compliance',
		fixed: [
			'Removed redundant "Obsidian" prefix in manifest description in compliance with Community Plugin review rules.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.1.3',
		date: '2026-09-06',
		title: 'Strict TypeScript Architecture & Official Linting Readiness',
		highlights: [
			'100% strict TypeScript types across all Claudian and Obsidian Copilot integration bridges.',
			'Zero ESLint warnings under official eslint-plugin-obsidianmd ruleset.',
		],
		added: [
			'Type-safe bridge interfaces for Claudian and Obsidian Copilot internals.',
			'Safe profile parsers and tab resolution helpers.',
		],
		changed: [
			'Decoupled settings re-render lifecycles to eliminate deprecation warnings.',
			'Standardized UI copy to Obsidian sentence-case conventions.',
		],
		fixed: [
			'Unhandled type coercion in clock parsers for non-string values.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.1.2',
		date: '2026-09-06',
		title: 'Native Accessible Dialogs',
		added: [
			'Native Obsidian ConfirmModal for destructive actions (job deletion, bulk disable, bulk delete).',
			'Declarative setting definitions for forward compatibility.',
		],
		fixed: [
			'Hardened multi-rule JSON deserialization with safe unknown type assertions.',
			'Improved clock string regex matching on edge-case inputs.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.1.1',
		date: '2026-09-05',
		title: 'Zero-Dependency Cron Engine & Two-Way Synced Schedule Notes',
		highlights: [
			'Pure 5-field cron scheduling engine bundled directly into the plugin source.',
			'Two-way synced Markdown notes in AI Schedules/ with YAML frontmatter sync.',
			'DST-safe scheduling arithmetic skipping invalid wall times.',
		],
		added: [
			'Full 5-field cron expression support (minute hour dom month dow) with live validation.',
			'Startup catch-up engine to evaluate jobs due while Obsidian was closed.',
			'Run recovery mechanism to gracefully reset interrupted tasks.',
		],
		changed: [
			'Rebuilt entire plugin core from modular TypeScript sources with esbuild bundling.',
			'Added comprehensive unit test suite covering cron math and execution state machines.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.1.0',
		date: '2026-08-22',
		title: 'Dual Backend Architecture & Task Context Binding',
		highlights: [
			'Native support for Obsidian Copilot alongside Claudian.',
			'Contextual note and folder binding for scheduled tasks.',
		],
		added: [
			'Dual backend switch in settings (Claudian or Obsidian Copilot).',
			'Interval schedules (every N minutes or hours with bounded iteration limits).',
			'Vault project folder and active note context binding.',
			'Custom output routing to dedicated vault folders.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.0.4',
		date: '2026-08-22',
		title: 'Automated CI Pipeline & Smoke Testing',
		added: [
			'Automated GitHub Actions release pipeline.',
			'Smoke testing harness against mock Obsidian runtime.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.0.3',
		date: '2026-08-22',
		title: 'Redesigned Assistant Dashboard',
		changed: [
			'Categorized dashboard tabs: Active Tasks, Disabled Tasks, and Past Completed Tasks.',
			'Task numbering (#1, #2...) and visual context badges (Independent vs Project-based).',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.0.2',
		date: '2026-08-22',
		title: 'Multi-Model Routing Profiles',
		added: [
			'Configure separate AI models for Planning, Task Execution, Daily Previews, and Nightly Reviews.',
			'Live model refresher button in settings.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.0.1',
		date: '2026-08-21',
		title: 'Session Persistence & Namespace Polish',
		fixed: [
			'Claudian conversation persistence and session lifecycle management.',
			'Standardized CSS class namespaces under ai-scheduler.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
	{
		version: '2.0.0',
		date: '2026-08-21',
		title: 'Initial Release of AI Scheduler',
		highlights: [
			'First autonomous background scheduling and proactive intelligence engine for Obsidian.',
			'Automate recurring prompts, vault maintenance, and nightly reviews.',
		],
		contributors: [
			{
				name: 'racstan',
				username: 'racstan',
				url: 'https://github.com/racstan',
				role: 'Author',
			},
		],
	},
];

export function getLatestRelease(): ReleaseChangelog {
	return CHANGELOG_DATA[0];
}

/** Numeric, segment-by-segment version comparison ("2.1.10" > "2.1.9"). */
export function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(part => Number(part) || 0);
	const right = b.split('.').map(part => Number(part) || 0);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function getReleasesSince(previousVersion: string | null | undefined): ReleaseChangelog[] {
	if (!previousVersion) return [CHANGELOG_DATA[0]];
	const index = CHANGELOG_DATA.findIndex(r => r.version === previousVersion);
	if (index === -1) {
		// Unknown previous version (e.g. a release missing from this list): show
		// every release newer than it rather than guessing.
		const newer = CHANGELOG_DATA.filter(r => compareVersions(r.version, previousVersion) > 0);
		return newer.length ? newer : [CHANGELOG_DATA[0]];
	}
	if (index === 0) {
		return [CHANGELOG_DATA[0]];
	}
	return CHANGELOG_DATA.slice(0, index);
}
