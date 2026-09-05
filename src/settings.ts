/* Settings, job normalization, and stored-data parsing (faithful port of the
 * original onload migration logic), plus the two new opt-in note settings. */
import { ActivityEntry, AISettings, Job, JobStatus, SCHEDULE_KINDS, TaskSchedule } from './types';
import { getScheduleNextRun } from './schedule';
import { id } from './util';

export const DEFAULT_SETTINGS: AISettings = {
	assistantTab: 1,
	backendMode: 'claudian',
	planningModel: '',
	executionModel: '',
	dailyReviewModel: '',
	nightlyReviewModel: '',
	reportFolder: 'AI Reviews',
	reviewTime: '22:00',
	nightlyReviewEnabled: false,
	notifyOnCompletion: true,
	catchUpOnStart: false,
	catchUpHours: 24,
	reviewContextMode: 'modified-today',
	scheduleNotesEnabled: false,
	scheduleFolder: 'AI Schedules',
};

export function normalizeJob(raw: Record<string, unknown>, now: Date = new Date()): Job {
	const scheduleRaw = (raw.schedule || (raw.sendAt
		? { kind: 'once', at: raw.sendAt }
		: { kind: 'once', at: new Date(Date.now() + 60000).toISOString() })) as Record<string, unknown>;
	const normalizedSchedule: TaskSchedule = {
		kind: (SCHEDULE_KINDS as string[]).includes(String(scheduleRaw.kind)) ? scheduleRaw.kind as TaskSchedule['kind'] : 'once',
		at: scheduleRaw.at as string | undefined,
		time: scheduleRaw.time as string | undefined,
		days: scheduleRaw.days as number[] | undefined,
		rules: scheduleRaw.rules as TaskSchedule['rules'],
		event: scheduleRaw.event as string | undefined,
		intervalMinutes: (scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || (Number(scheduleRaw.everyHours || 0) * 60)) as number | null,
		maxIterations: normalizeMaxIterationsField(scheduleRaw.maxIterations || scheduleRaw.maxRuns || scheduleRaw.iterations),
		expression: scheduleRaw.expression as string | undefined,
	};
	const nextRunAt = raw.nextRunAt !== undefined
		? raw.nextRunAt as string | null
		: getScheduleNextRun(normalizedSchedule, now);
	return Object.assign({
		id: id('job'),
		title: 'Assistant task',
		prompt: '',
		tab: 1,
		enabled: true,
		status: 'scheduled',
		createdAt: new Date().toISOString(),
		lastRunAt: null,
		lastStatus: null,
		lastReply: '',
		lastError: null,
		routine: null,
		notify: true,
		output: null,
		contextPaths: Array.isArray(raw.contextPaths)
			? raw.contextPaths as string[]
			: (raw.context as { paths?: string[] } | undefined)?.paths && Array.isArray((raw.context as { paths?: string[] }).paths)
				? (raw.context as { paths: string[] }).paths
				: [],
		attempts: 0,
		runCount: Number(raw.runCount || 0),
		taskNumber: Number(raw.taskNumber || 0),
		profile: null,
		conversationId: null,
		providerId: null,
		model: null,
	}, raw, { schedule: normalizedSchedule, nextRunAt }) as Job;
}

function normalizeMaxIterationsField(value: unknown): number | null {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : null;
}

/** Parses data.json contents into settings/jobs/activity with all legacy migrations. */
export function parseStoredData(data: Record<string, unknown> | null | undefined): {
	settings: AISettings;
	jobs: Job[];
	activity: ActivityEntry[];
} {
	const stored = data || {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
	settings.backendMode = settings.backendMode === 'copilot' ? 'copilot' : 'claudian';
	// Migrate the old profile names to explicit models for each action. The
	// values are still Claudian model references, but users no longer need to
	// understand the internal conversation/profile concept.
	const oldSettings = (stored.settings || {}) as Record<string, unknown>;
	const oldDefault = (oldSettings.defaultProfile || oldSettings.planningProfile || '') as string;
	settings.planningModel = settings.planningModel || (oldSettings.planningProfile as string) || oldDefault;
	settings.executionModel = settings.executionModel || oldDefault;
	settings.dailyReviewModel = settings.dailyReviewModel || (oldSettings.nightlyProfile as string) || oldDefault;
	settings.nightlyReviewModel = settings.nightlyReviewModel || (oldSettings.nightlyProfile as string) || oldDefault;
	// v2 shipped startup catch-up enabled. Apply the safer opt-in behavior to
	// existing installations as well as new ones.
	if (!stored.version || (stored.version as number) < 3) settings.catchUpOnStart = false;
	// New in 2.1.1: opt-in schedule notes. Existing installs keep data.json
	// storage until they explicitly turn notes on in settings.
	if (typeof settings.scheduleNotesEnabled !== 'boolean') settings.scheduleNotesEnabled = false;
	if (!settings.scheduleFolder) settings.scheduleFolder = DEFAULT_SETTINGS.scheduleFolder;

	const legacyTasks = stored.tasks as Array<Record<string, unknown>> | undefined;
	const jobs = Array.isArray(stored.jobs)
		? (stored.jobs as Array<Record<string, unknown>>).map(job => normalizeJob(job))
		: (Array.isArray(legacyTasks)
			? legacyTasks.map(task => normalizeJob({
				...task,
				title: task.title || 'Migrated task',
				prompt: task.prompt || task.content || '',
				schedule: { kind: 'once', at: task.sendAt },
				enabled: task.status === 'pending',
			}))
			: []);
	const activity = Array.isArray(stored.activity) ? (stored.activity as ActivityEntry[]).slice(-50) : [];
	return { settings, jobs, activity };
}
