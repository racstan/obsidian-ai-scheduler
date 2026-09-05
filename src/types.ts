/*
 * AI Scheduler - an autonomy layer for Claudian and Obsidian Copilot.
 *
 * This plugin deliberately does not call an AI provider directly. The selected
 * backend owns providers, models, permissions, and vault tools; this plugin
 * owns when the agent should wake up and what should happen after it replies.
 */
export type BackendMode = 'claudian' | 'copilot';

export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'multi' | 'hourly' | 'interval' | 'event' | 'cron';

export type JobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'disabled' | 'missed';

export interface MultiRule {
	days: number[];
	times: string[];
}

export interface TaskSchedule {
	kind: ScheduleKind;
	/** ISO-8601 timestamp for kind 'once'. */
	at?: string;
	/** HH:MM local time for 'daily' and 'weekly'. */
	time?: string;
	/** Weekday numbers 0-6 (Sunday 0) for 'weekly'. */
	days?: number[];
	/** Weekday/time rule list for 'multi'. */
	rules?: MultiRule[];
	/** Vault event name for 'event'. */
	event?: string;
	/** Cadence in minutes for 'hourly' (60) and 'interval'. */
	intervalMinutes?: number | null;
	/** Optional bound on total runs for recurring kinds. */
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
	catchUpOnStart: boolean;
	catchUpHours: number;
	reviewContextMode: 'modified-today' | 'all-markdown' | 'no-files';
	/** Opt-in: mirror every job definition into a note inside scheduleFolder. */
	scheduleNotesEnabled: boolean;
	/** Vault folder used for the opt-in schedule notes. */
	scheduleFolder: string;
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

export const SCHEDULE_KINDS: ScheduleKind[] = ['once', 'daily', 'weekly', 'multi', 'hourly', 'interval', 'event', 'cron'];
