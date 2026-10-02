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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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
				name: 'Rachit Asthana',
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

export function getReleasesSince(previousVersion: string | null | undefined): ReleaseChangelog[] {
	if (!previousVersion) return [CHANGELOG_DATA[0]];
	const index = CHANGELOG_DATA.findIndex(r => r.version === previousVersion);
	if (index === -1) {
		return [CHANGELOG_DATA[0]];
	}
	if (index === 0) {
		return [CHANGELOG_DATA[0]];
	}
	return CHANGELOG_DATA.slice(0, index);
}
