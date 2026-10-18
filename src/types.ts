/*
 * AI Scheduler - an autonomy layer for Claudian and Copilot.
 *
 * This plugin deliberately does not call an AI provider directly. The selected
 * backend owns providers, models, permissions, and vault tools; this plugin
 * owns when the agent should wake up and what should happen after it replies.
 */
import { AIDraft } from './drafts';
import type { CalendarEvent } from './calendars/events';
export type BackendMode = 'claudian' | 'oh-my-claudian' | 'copilot' | 'none';

/** Claudian and its fork Oh My Claudian share one integration. */
export type ClaudianBackend = 'claudian' | 'oh-my-claudian';

export function isClaudianBackend(mode: string | null | undefined): mode is ClaudianBackend {
	return mode === 'claudian' || mode === 'oh-my-claudian';
}

export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'multi' | 'hourly' | 'interval' | 'event' | 'after' | 'cron' | 'meeting';

export type JobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'disabled' | 'missed';

export interface MultiRule {
	days: number[];
	times: string[];
}

export interface TaskSchedule {
	kind: ScheduleKind;
	/** ISO-8601 timestamp for kind 'once' or reference time. */
	at?: string;
	/** Starting date or ISO timestamp for initial execution. */
	startAt?: string;
	/** HH:MM local time for 'daily', 'weekly', 'monthly', 'yearly', and start of 'interval'. */
	time?: string;
	/** Weekday numbers 0-6 (Sunday 0) for 'weekly'. */
	days?: number[];
	/** Interval in days for every N days (default 1). */
	everyDays?: number;
	/** Interval in weeks for every N weeks (default 1). */
	everyWeeks?: number;
	/** Day of month (1-31) for 'monthly' and 'yearly'. */
	dayOfMonth?: number;
	/** Month number (1-12) for 'yearly'. */
	month?: number;
	/** Interval in months for every N months (default 1). */
	everyMonths?: number;
	/** Weekday/time rule list for 'multi'. */
	rules?: MultiRule[];
	/** Vault event name for 'event'. */
	event?: string;
	/** Cadence in minutes for 'hourly' (60) and 'interval'. */
	intervalMinutes?: number | null;
	/** Optional bound on total runs (run for N times then done). */
	maxIterations?: number | null;
	/** 5-field cron expression for kind 'cron'. */
	expression?: string;
	/** Id of the task whose successful run starts this one, for kind 'after'. */
	afterTask?: string;
	/** Minutes before a Google Calendar event, for kind 'meeting'. */
	minutesBefore?: number;
	/** Comma-separated words; a 'meeting' task runs only for events whose title contains one (empty = every event). */
	eventMatch?: string;
}

/**
 * Where a run's result goes:
 * - new: a new note every run (the default);
 * - replace: one note, replaced on each run;
 * - append: added to the end of one note, or under `heading`;
 * - daily: added to today's daily note, at the end or under `heading`.
 */
export type OutputMode = 'new' | 'replace' | 'append' | 'daily';

export const OUTPUT_MODES: OutputMode[] = ['new', 'replace', 'append', 'daily'];

export interface JobOutput {
	folder?: string;
	filename?: string;
	mode?: OutputMode;
	heading?: string;
	/** Write action items as Tasks-plugin task lines ("- [ ] …"). */
	tasks?: boolean;
	/** Tag added to each open task line, e.g. "ai". */
	taskTag?: string;
	/** Vault path of a template note for new result notes ({{result}} marks where the result goes). */
	template?: string;
}

export type RunOutcome = 'completed' | 'failed' | 'skipped' | 'cancelled';

/** One entry of a task's run history (the newest few are kept). */
export interface RunRecord {
	/** ISO start time. */
	at: string;
	status: RunOutcome;
	durationMs?: number;
	/** Note the run wrote to. */
	output?: string;
	/** Error, or why the run was skipped. */
	error?: string;
	/** Set on a run that was an automatic retry (1 = first retry). */
	retry?: number;
	/** Approval mode: changes this run left waiting for approval. */
	pending?: number;
	/** Approval mode: notes changed directly while the run was going (not through approval). */
	changed?: string[];
}

export interface Job {
	id: string;
	title: string;
	prompt: string;
	tab: number;
	enabled: boolean;
	status: JobStatus;
	createdAt: string;
	lastRunAt: string | null;
	lastStatus: string | null;
	lastReply: string;
	lastError: string | null;
	routine: string | null;
	notify: boolean;
	output: JobOutput | null;
	contextPaths: string[];
	attempts: number;
	runCount: number;
	taskNumber: number;
	profile: string | null;
	conversationId: string | null;
	providerId: string | null;
	model: string | null;
	schedule: TaskSchedule;
	nextRunAt: string | null;
	cooldownMinutes?: number;
	lastEventPath?: string;
	source?: string;
	/** Vault path of the mirrored schedule note (opt-in notes storage). */
	notePath?: string | null;
	/** The user moved the note out of the schedules folder; keep it where it is. */
	noteMovedByUser?: boolean;
	/** Path of the primary output file created or modified by this task. */
	lastOutputPath?: string | null;
	/** lastOutputPath is a note the last run added to, not one the plugin created. */
	lastOutputAppended?: boolean;
	/** List of files created or modified during the task execution. */
	lastOutputFiles?: string[];
	/** Optional clarification or doubt note generated during AI planning. */
	doubt?: string | null;
	/** Automatic retries after a failed run (0 = none). */
	retries?: number;
	/** Minutes between a failure and its retry. */
	retryDelayMinutes?: number;
	/** Stop a run that takes longer than this many minutes (0 or unset = no limit). */
	timeoutMinutes?: number;
	/** Skip a run when nothing it reads has changed since the last successful run. */
	onlyIfChanged?: boolean;
	/** Retries used for the current failure; reset by a successful run. */
	retryCount?: number;
	/** End time of the last successful run. */
	lastSuccessAt?: string | null;
	/** Most recent runs, oldest first. */
	history?: RunRecord[];
	/** Labels for finding and grouping tasks on the dashboard. */
	tags?: string[];
	/** Kind 'meeting': the calendar event the next (or current) run is for. */
	triggerEvent?: CalendarEvent;
	/** Kind 'meeting': events already handled (newest last), so each runs the task once. */
	firedEvents?: string[];
}

export interface AISettings {
	assistantTab: number;
	backendMode: BackendMode;
	planningModel: string;
	executionModel: string;
	dailyReviewModel: string;
	nightlyReviewModel: string;
	reportFolder: string;
	reviewTime: string;
	nightlyReviewEnabled: boolean;
	periodicReviewCadence?: 'daily' | 'weekly' | 'every-n-days' | 'hourly';
	periodicReviewDays?: number[];
	periodicReviewEveryDays?: number;
	periodicReviewHours?: number;
	notifyOnCompletion: boolean;
	systemNotifications: boolean;
	catchUpOnStart: boolean;
	catchUpHours: number;
	reviewContextMode: 'modified-today' | 'all-markdown' | 'no-files';
	/** Opt-in: mirror every job definition into a note inside scheduleFolder. */
	scheduleNotesEnabled: boolean;
	/** Vault folder used for the opt-in schedule notes. */
	scheduleFolder: string;
	/** Last seen plugin version for showing what's new. */
	lastSeenVersion: string;
	/** Whether to automatically show the changelog after an update. */
	showChangelogOnUpdate: boolean;
	/** Default output folder for tasks that don't specify an output location.
	 *  Falls back to 'AI Scheduler' if empty. */
	defaultOutputFolder: string;
	/** Whether to append an entry to the task log file after each run. */
	taskLoggingEnabled: boolean;
	/** Folder where the task log file lives. Falls back to defaultOutputFolder
	 *  (or 'AI Scheduler') if empty. The log file is always named
	 *  'AI SCHEDULER LOGS.md' inside this folder. */
	taskLogFolder: string;
	/** Keep an .ics calendar file of upcoming runs up to date. */
	icsExportEnabled: boolean;
	/** Vault path of the .ics file. */
	icsExportPath: string;
	/** How many days ahead the .ics file covers. */
	icsExportDays: number;
	/** The getting-started note was shown on first install. */
	gettingStartedShown: boolean;
	/** No task starts on its own while paused ("Run now" still works). */
	paused: boolean;
	/** ISO time the pause ends by itself; null = until resumed. */
	pausedUntil: string | null;
	/** Tasks due during quiet hours wait until the quiet hours end. */
	quietHoursEnabled: boolean;
	/** HH:MM start of the quiet hours. */
	quietStart: string;
	/** HH:MM end of the quiet hours (may be on the next day). */
	quietEnd: string;
	/** Show the next run in the status bar when nothing is running. */
	statusBarNextRun: boolean;
	/** Approval mode: changes tasks would make to notes that already exist wait for the user's approval. */
	approvalMode: boolean;
	/** Unsent AI requests ("Ask AI to plan", "Update task with AI"), by form. */
	drafts: Record<string, AIDraft>;
	/** How many days ahead the "AI Scheduler" calendars in Google and Outlook show. */
	calendarRunDays: number;
	/** Google Calendar (beta): keep an "AI Scheduler" calendar in Google up to date. */
	googleShowRuns: boolean;
	/** Google calendar ids read for {{today_events}} and meeting tasks (empty = the main calendar). */
	googleCalendars: string[];
	/** The user's own Google OAuth client ("Desktop app"). */
	googleClientId: string;
	googleClientSecret: string;
	/** Outlook (beta): keep an "AI Scheduler" calendar in Outlook up to date. */
	outlookShowRuns: boolean;
	/** Outlook calendar ids read (empty = the main calendar). */
	outlookCalendars: string[];
	/** The user's own Microsoft app registration (client ID; no secret). */
	outlookClientId: string;
}

export interface ActivityEntry {
	id: string;
	at: string;
	type: string;
	message: string;
	jobId?: string | null;
}

export interface PluginData {
	version: number;
	settings: AISettings;
	jobs: Job[];
	deletedJobs?: Job[];
	activity: ActivityEntry[];
}

export const BACKEND_INFO = {
	claudian: {
		name: 'Claudian',
		pluginId: 'realclaudian',
		githubUrl: 'https://github.com/YishenTu/claudian',
	},
	'oh-my-claudian': {
		name: 'Oh My Claudian',
		pluginId: 'oh-my-claudian',
		githubUrl: 'https://github.com/lee259/oh-my-claudian',
	},
	copilot: {
		name: 'Copilot',
		pluginId: 'copilot',
		githubUrl: 'https://github.com/logancyang/obsidian-copilot',
	},
} as const;

export const SCHEDULE_KINDS: ScheduleKind[] = ['once', 'daily', 'weekly', 'monthly', 'yearly', 'hourly', 'interval', 'multi', 'event', 'after', 'meeting', 'cron'];
