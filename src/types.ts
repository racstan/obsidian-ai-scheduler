/*
 * AI Scheduler - an autonomy layer for Claudian and Obsidian Copilot.
 *
 * This plugin deliberately does not call an AI provider directly. The selected
 * backend owns providers, models, permissions, and vault tools; this plugin
 * owns when the agent should wake up and what should happen after it replies.
 */
export type BackendMode = 'claudian' | 'copilot' | 'none';

export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'multi' | 'hourly' | 'interval' | 'event' | 'cron';

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
}

export interface JobOutput {
	folder?: string;
	filename?: string;
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
	/** Path of the primary output file created or modified by this task. */
	lastOutputPath?: string | null;
	/** List of files created or modified during the task execution. */
	lastOutputFiles?: string[];
	/** Optional clarification or doubt note generated during AI planning. */
	doubt?: string | null;
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
	copilot: {
		name: 'Obsidian Copilot',
		pluginId: 'copilot',
		githubUrl: 'https://github.com/logancyang/obsidian-copilot',
	},
} as const;

export const SCHEDULE_KINDS: ScheduleKind[] = ['once', 'daily', 'weekly', 'monthly', 'yearly', 'hourly', 'interval', 'multi', 'event', 'cron'];
