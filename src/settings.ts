/* Settings, job normalization, and stored-data parsing (faithful port of the
 * original onload migration logic), plus the two new opt-in note settings. */
import { ActivityEntry, AISettings, Job, JobOutput, SCHEDULE_KINDS, TaskSchedule } from './types';
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
	systemNotifications: true,
	catchUpOnStart: false,
	catchUpHours: 24,
	reviewContextMode: 'modified-today',
	scheduleNotesEnabled: false,
	scheduleFolder: 'AI Schedules',
	lastSeenVersion: '',
	showChangelogOnUpdate: true,
};

const VALID_STATUSES = new Set(['scheduled', 'running', 'completed', 'failed', 'missed', 'disabled']);

function normalizeOutput(output: unknown): JobOutput | null {
	if (!output || typeof output !== 'object') return null;
	const record = output as Record<string, unknown>;
	return {
		folder: typeof record.folder === 'string' ? record.folder : undefined,
		filename: typeof record.filename === 'string' ? record.filename : undefined,
	};
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
		event: typeof scheduleRaw.event === 'string' ? scheduleRaw.event : undefined,
		intervalMinutes: Number.isFinite(Number(scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || (Number(scheduleRaw.everyHours || 0) * 60)))
			? Number(scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || (Number(scheduleRaw.everyHours || 0) * 60))
			: null,
		maxIterations: normalizeMaxIterationsField(scheduleRaw.maxIterations || scheduleRaw.maxRuns || scheduleRaw.iterations),
		expression: typeof scheduleRaw.expression === 'string' ? scheduleRaw.expression : undefined,
	};
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
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
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
		lastOutputPath: typeof raw.lastOutputPath === 'string' ? raw.lastOutputPath : null,
		lastOutputFiles: Array.isArray(raw.lastOutputFiles) ? raw.lastOutputFiles.map(String) : undefined,
		cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes >= 0 ? cooldownMinutes : undefined,
		lastEventPath: typeof raw.lastEventPath === 'string' ? raw.lastEventPath : undefined,
		source: typeof raw.source === 'string' ? raw.source : undefined,
		schedule: normalizedSchedule,
		nextRunAt,
	};
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
	const oldSettings = (stored.settings || {}) as Record<string, unknown>;
	const settings = Object.assign({}, DEFAULT_SETTINGS, oldSettings as Partial<AISettings>);
	const rawBackend = typeof oldSettings.backendMode === 'string' ? oldSettings.backendMode : '';
	settings.backendMode = rawBackend === 'copilot' ? 'copilot' : rawBackend === 'claudian' ? 'claudian' : (rawBackend === 'none' ? 'none' : DEFAULT_SETTINGS.backendMode);
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
