/* Settings, job normalization, and stored-data parsing (faithful port of the
 * original onload migration logic), plus the two new opt-in note settings. */
import { ActivityEntry, AISettings, Job, JobOutput, OUTPUT_MODES, OutputMode, RunRecord, SCHEDULE_KINDS, TaskSchedule } from './types';
import { getScheduleNextRun, normalizeMaxIterations } from './schedule';
import { id, localDateKey } from './util';
import { normalizeDrafts } from './drafts';

export const DEFAULT_SETTINGS: AISettings = {
	assistantTab: 1,
	backendMode: 'claudian',
	planningModel: '',
	executionModel: '',
	dailyReviewModel: '',
	nightlyReviewModel: '',
	reportFolder: '',
	reviewTime: '22:00',
	nightlyReviewEnabled: false,
	periodicReviewCadence: 'daily',
	periodicReviewDays: [1],
	periodicReviewEveryDays: 2,
	periodicReviewHours: 12,
	notifyOnCompletion: true,
	systemNotifications: true,
	catchUpOnStart: false,
	catchUpHours: 24,
	reviewContextMode: 'modified-today',
	scheduleNotesEnabled: false,
	scheduleFolder: 'AI Schedules',
	lastSeenVersion: '',
	showChangelogOnUpdate: true,
	defaultOutputFolder: '',
	taskLoggingEnabled: false,
	taskLogFolder: '',
	icsExportEnabled: false,
	icsExportPath: 'AI Scheduler/AI Scheduler.ics',
	icsExportDays: 30,
	gettingStartedShown: false,
	paused: false,
	pausedUntil: null,
	quietHoursEnabled: false,
	quietStart: '23:00',
	quietEnd: '07:00',
	statusBarNextRun: true,
	drafts: {},
};

const VALID_STATUSES = new Set(['scheduled', 'running', 'completed', 'failed', 'missed', 'disabled', 'cancelled']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** An interval in whole minutes (at least 1), or null when there is none. */
function wholeMinutes(value: number): number | null {
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : null;
}

function normalizeOutput(output: unknown): JobOutput | null {
	if (!output || typeof output !== 'object') return null;
	const record = output as Record<string, unknown>;
	const normalized: JobOutput = {
		folder: typeof record.folder === 'string' ? record.folder : undefined,
		filename: typeof record.filename === 'string' ? record.filename : undefined,
	};
	if ((OUTPUT_MODES as string[]).includes(String(record.mode))) normalized.mode = record.mode as OutputMode;
	if (typeof record.heading === 'string' && record.heading.trim()) normalized.heading = record.heading;
	return normalized;
}

const RUN_OUTCOMES = new Set(['completed', 'failed', 'skipped', 'cancelled']);

function normalizeHistory(raw: unknown): RunRecord[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const records = raw
		.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
		.filter(entry => typeof entry.at === 'string' && RUN_OUTCOMES.has(String(entry.status)))
		.map(entry => {
			const record: RunRecord = { at: entry.at as string, status: entry.status as RunRecord['status'] };
			const duration = Number(entry.durationMs);
			if (Number.isFinite(duration) && duration >= 0) record.durationMs = duration;
			if (typeof entry.output === 'string') record.output = entry.output;
			if (typeof entry.error === 'string') record.error = entry.error;
			const retry = Number(entry.retry);
			if (Number.isInteger(retry) && retry > 0) record.retry = retry;
			return record;
		});
	return records.length ? records.slice(-20) : undefined;
}

export function normalizeJob(raw: Record<string, unknown>, now: Date = new Date()): Job {
	const scheduleRaw = (raw.schedule || (raw.sendAt
		? { kind: 'once', at: raw.sendAt }
		: { kind: 'once', at: new Date(Date.now() + 60000).toISOString() })) as Record<string, unknown>;
	const normalizedSchedule: TaskSchedule = {
		kind: (SCHEDULE_KINDS as string[]).includes(String(scheduleRaw.kind)) ? scheduleRaw.kind as TaskSchedule['kind'] : 'once',
		at: typeof scheduleRaw.at === 'string' ? scheduleRaw.at : undefined,
		time: typeof scheduleRaw.time === 'string' ? scheduleRaw.time : undefined,
		days: Array.isArray(scheduleRaw.days) ? scheduleRaw.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : undefined,
		rules: scheduleRaw.rules as TaskSchedule['rules'],
		// Only vault modify/create events exist; anything else silently never fired.
		event: typeof scheduleRaw.event === 'string'
			? (['modify', 'vault-change'].includes(scheduleRaw.event) ? scheduleRaw.event : 'modify')
			: undefined,
		intervalMinutes: wholeMinutes(Number(scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || (Number(scheduleRaw.everyHours || 0) * 60))),
		maxIterations: normalizeMaxIterations(scheduleRaw.maxIterations || scheduleRaw.maxRuns || scheduleRaw.iterations),
		expression: typeof scheduleRaw.expression === 'string' ? scheduleRaw.expression : undefined,
		afterTask: typeof scheduleRaw.afterTask === 'string' && scheduleRaw.afterTask ? scheduleRaw.afterTask : undefined,
		startAt: typeof scheduleRaw.startAt === 'string' && !Number.isNaN(new Date(scheduleRaw.startAt).getTime()) ? scheduleRaw.startAt : undefined,
		everyDays: intInRange(scheduleRaw.everyDays, 1, Number.MAX_SAFE_INTEGER),
		everyWeeks: intInRange(scheduleRaw.everyWeeks, 1, Number.MAX_SAFE_INTEGER),
		everyMonths: intInRange(scheduleRaw.everyMonths, 1, Number.MAX_SAFE_INTEGER),
		dayOfMonth: intInRange(scheduleRaw.dayOfMonth, 1, 31),
		month: intInRange(scheduleRaw.month, 1, 12),
	};
	// A weekly schedule with no days used "whatever weekday it is now" on every
	// reschedule, so it drifted. Pin it to the weekday the job was created.
	if (normalizedSchedule.kind === 'weekly' && !normalizedSchedule.days?.length) {
		const created = typeof raw.createdAt === 'string' && !Number.isNaN(new Date(raw.createdAt).getTime()) ? new Date(raw.createdAt) : now;
		normalizedSchedule.days = [created.getDay()];
	}
	// "Every N days/weeks/months" needs an anchor to count from; without one the
	// step was ignored (weeks/months) or restarted on every reschedule (days).
	// Default it to the day the job was created, which is then persisted.
	const stepped = (normalizedSchedule.kind === 'daily' && (normalizedSchedule.everyDays ?? 1) > 1)
		|| (normalizedSchedule.kind === 'weekly' && (normalizedSchedule.everyWeeks ?? 1) > 1)
		|| (normalizedSchedule.kind === 'monthly' && (normalizedSchedule.everyMonths ?? 1) > 1);
	if (stepped && !normalizedSchedule.startAt) {
		const created = typeof raw.createdAt === 'string' && !Number.isNaN(new Date(raw.createdAt).getTime()) ? new Date(raw.createdAt) : now;
		normalizedSchedule.startAt = localDateKey(created);
	}
	// Drop absent optional fields so stored and round-tripped schedules stay identical.
	for (const key of Object.keys(normalizedSchedule) as (keyof TaskSchedule)[]) {
		if (normalizedSchedule[key] === undefined) delete normalizedSchedule[key];
	}
	const nextRunAt = raw.nextRunAt !== undefined && (typeof raw.nextRunAt === 'string' || raw.nextRunAt === null)
		? raw.nextRunAt
		: getScheduleNextRun(normalizedSchedule, now);

	const enabled = typeof raw.enabled === 'boolean'
		? raw.enabled
		: raw.enabled === 'false' ? false : true;

	const rawStatus = typeof raw.status === 'string' ? raw.status : '';
	const status = VALID_STATUSES.has(rawStatus)
		? rawStatus as Job['status']
		: (enabled ? 'scheduled' : 'disabled');

	const attempts = Number(raw.attempts);
	const runCount = Number(raw.runCount);
	const taskNumber = Number(raw.taskNumber);
	const tab = Number(raw.tab);
	const cooldownMinutes = Number(raw.cooldownMinutes);

	return {
		id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : id('job'),
		title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Assistant task',
		prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
		tab: Number.isInteger(tab) && tab > 0 ? tab : 1,
		enabled,
		status,
		createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(new Date(raw.createdAt).getTime()) ? raw.createdAt : new Date().toISOString(),
		lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
		lastStatus: typeof raw.lastStatus === 'string' && VALID_STATUSES.has(raw.lastStatus) ? raw.lastStatus : null,
		lastReply: typeof raw.lastReply === 'string' ? raw.lastReply : '',
		lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
		routine: typeof raw.routine === 'string' ? raw.routine : null,
		notify: raw.notify !== false,
		output: normalizeOutput(raw.output),
		contextPaths: Array.isArray(raw.contextPaths)
			? raw.contextPaths.map(String)
			: (raw.context as { paths?: string[] } | undefined)?.paths && Array.isArray((raw.context as { paths?: string[] }).paths)
				? (raw.context as { paths: string[] }).paths.map(String)
				: [],
		attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : 0,
		runCount: Number.isFinite(runCount) && runCount >= 0 ? runCount : 0,
		taskNumber: Number.isFinite(taskNumber) && taskNumber >= 0 ? taskNumber : 0,
		profile: typeof raw.profile === 'string' ? raw.profile : null,
		conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
		providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
		model: typeof raw.model === 'string' ? raw.model : null,
		notePath: typeof raw.notePath === 'string' ? raw.notePath : null,
		noteMovedByUser: raw.noteMovedByUser === true ? true : undefined,
		lastOutputPath: typeof raw.lastOutputPath === 'string' ? raw.lastOutputPath : null,
		lastOutputAppended: raw.lastOutputAppended === true ? true : undefined,
		lastOutputFiles: Array.isArray(raw.lastOutputFiles) ? raw.lastOutputFiles.map(String) : undefined,
		cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes >= 0 ? cooldownMinutes : undefined,
		lastEventPath: typeof raw.lastEventPath === 'string' ? raw.lastEventPath : undefined,
		source: typeof raw.source === 'string' ? raw.source : undefined,
		doubt: typeof raw.doubt === 'string' ? raw.doubt : undefined,
		retries: intInRange(raw.retries, 0, 5),
		retryDelayMinutes: intInRange(raw.retryDelayMinutes, 1, 1440),
		timeoutMinutes: intInRange(raw.timeoutMinutes, 0, 1440),
		onlyIfChanged: raw.onlyIfChanged === true ? true : undefined,
		retryCount: intInRange(raw.retryCount, 0, 5),
		lastSuccessAt: typeof raw.lastSuccessAt === 'string' ? raw.lastSuccessAt : undefined,
		history: normalizeHistory(raw.history),
		tags: normalizeTags(raw.tags),
		schedule: normalizedSchedule,
		nextRunAt,
	};
}

/** Tags without '#', trimmed, unique (case-insensitively), at most 20. */
export function normalizeTags(raw: unknown): string[] | undefined {
	const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const entry of list) {
		const tag = String(entry ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 40);
		if (!tag || seen.has(tag.toLowerCase())) continue;
		seen.add(tag.toLowerCase());
		tags.push(tag);
	}
	return tags.length ? tags.slice(0, 20) : undefined;
}

function intInRange(value: unknown, min: number, max: number): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const number = Number(value);
	return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

/** Parses data.json contents into settings/jobs/activity with all legacy migrations. */
export function parseStoredData(data: Record<string, unknown> | null | undefined): {
	settings: AISettings;
	jobs: Job[];
	deletedJobs: Job[];
	activity: ActivityEntry[];
} {
	const stored = data || {};
	const oldSettings = (stored.settings || {}) as Record<string, unknown>;
	const settings = Object.assign({}, DEFAULT_SETTINGS, oldSettings as Partial<AISettings>);
	const rawBackend = typeof oldSettings.backendMode === 'string' ? oldSettings.backendMode : '';
	settings.backendMode = (['copilot', 'claudian', 'oh-my-claudian', 'none'] as const).find(mode => mode === rawBackend) ?? DEFAULT_SETTINGS.backendMode;
	// Migrate the old profile names to explicit models for each action. The
	// values are still Claudian model references, but users no longer need to
	// understand the internal conversation/profile concept.
	const oldDefault = (oldSettings.defaultProfile || oldSettings.planningProfile || '') as string;
	settings.planningModel = settings.planningModel || (oldSettings.planningProfile as string) || oldDefault;
	settings.executionModel = settings.executionModel || oldDefault;
	settings.dailyReviewModel = settings.dailyReviewModel || (oldSettings.nightlyProfile as string) || oldDefault;
	settings.nightlyReviewModel = settings.nightlyReviewModel || (oldSettings.nightlyProfile as string) || oldDefault;
	// v2 shipped startup catch-up enabled. Apply the safer opt-in behavior to
	// existing installations as well as new ones.
	if (!stored.version || (stored.version as number) < 3) settings.catchUpOnStart = false;
	const rawCatchUp = Number(settings.catchUpHours);
	settings.catchUpHours = Number.isFinite(rawCatchUp) && rawCatchUp >= 0 ? rawCatchUp : 24;
	const validReviewContextModes = ['modified-today', 'all-markdown', 'no-files'];
	if (!validReviewContextModes.includes(settings.reviewContextMode)) {
		settings.reviewContextMode = 'modified-today';
	}
	// New in 2.1.1: opt-in schedule notes. Existing installs keep data.json
	// storage until they explicitly turn notes on in settings.
	if (typeof settings.scheduleNotesEnabled !== 'boolean') settings.scheduleNotesEnabled = false;
	if (!settings.scheduleFolder) settings.scheduleFolder = DEFAULT_SETTINGS.scheduleFolder;
	if (typeof settings.showChangelogOnUpdate !== 'boolean') settings.showChangelogOnUpdate = true;
	if (typeof settings.lastSeenVersion !== 'string') settings.lastSeenVersion = '';
	if (typeof settings.systemNotifications !== 'boolean') settings.systemNotifications = true;
	// New fields added in later versions — safe defaults for existing installs.
	if (typeof settings.defaultOutputFolder !== 'string') settings.defaultOutputFolder = '';
	if (typeof settings.taskLoggingEnabled !== 'boolean') settings.taskLoggingEnabled = false;
	if (typeof settings.taskLogFolder !== 'string') settings.taskLogFolder = '';
	settings.icsExportEnabled = settings.icsExportEnabled === true;
	settings.gettingStartedShown = settings.gettingStartedShown === true;
	settings.paused = settings.paused === true;
	settings.pausedUntil = settings.paused && typeof settings.pausedUntil === 'string' && !Number.isNaN(new Date(settings.pausedUntil).getTime())
		? settings.pausedUntil
		: null;
	settings.quietHoursEnabled = settings.quietHoursEnabled === true;
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.quietStart))) settings.quietStart = DEFAULT_SETTINGS.quietStart;
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.quietEnd))) settings.quietEnd = DEFAULT_SETTINGS.quietEnd;
	settings.statusBarNextRun = settings.statusBarNextRun !== false;
	settings.drafts = normalizeDrafts(settings.drafts);
	if (typeof settings.icsExportPath !== 'string' || !settings.icsExportPath.trim()) settings.icsExportPath = DEFAULT_SETTINGS.icsExportPath;
	const rawIcsDays = Number(settings.icsExportDays);
	settings.icsExportDays = Number.isInteger(rawIcsDays) && rawIcsDays >= 1 && rawIcsDays <= 366 ? rawIcsDays : DEFAULT_SETTINGS.icsExportDays;
	if (!['daily', 'weekly', 'every-n-days', 'hourly'].includes(settings.periodicReviewCadence as string)) {
		settings.periodicReviewCadence = 'daily';
	}
	// Keep only valid weekdays; fall back to the default (Monday) like a fresh install.
	settings.periodicReviewDays = Array.isArray(settings.periodicReviewDays)
		? [...new Set(settings.periodicReviewDays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
		: [];
	if (!settings.periodicReviewDays.length) settings.periodicReviewDays = [1];
	if (typeof settings.periodicReviewEveryDays !== 'number' || settings.periodicReviewEveryDays < 1) settings.periodicReviewEveryDays = 2;
	if (typeof settings.periodicReviewHours !== 'number' || settings.periodicReviewHours < 1) settings.periodicReviewHours = 12;

	const legacyTasks = stored.tasks as Array<Record<string, unknown>> | undefined;
	const jobs = Array.isArray(stored.jobs)
		? (stored.jobs as unknown[]).filter(isRecord).map(job => normalizeJob(job))
		: (Array.isArray(legacyTasks)
			? legacyTasks.map(task => normalizeJob({
				...task,
				title: task.title || 'Migrated task',
				prompt: task.prompt || task.content || '',
				schedule: { kind: 'once', at: task.sendAt },
				enabled: task.status === 'pending',
			}))
			: []);
	const deletedJobs = Array.isArray(stored.deletedJobs)
		? (stored.deletedJobs as unknown[]).filter(isRecord).map(job => normalizeJob(job))
		: [];
	// One damaged entry in data.json must not stop the plugin from loading.
	const activity = Array.isArray(stored.activity)
		? (stored.activity as unknown[]).filter((entry): entry is ActivityEntry => isRecord(entry) && typeof entry.message === 'string').slice(-50)
		: [];
	return { settings, jobs, deletedJobs, activity };
}
