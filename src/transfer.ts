/*
 * Task import and export as a JSON file, for backups and moving tasks between
 * vaults. Only the definition travels (title, instructions, schedule, results
 * and run options); run state, history and backend bindings stay behind.
 */
import { Job } from './types';
import { normalizeJob } from './settings';

export const EXPORT_FORMAT = 'ai-scheduler-tasks';
export const EXPORT_VERSION = 1;
const MAX_IMPORT = 200;

const DEFINITION_KEYS = [
	'id', 'title', 'prompt', 'schedule', 'output', 'contextPaths', 'notify', 'cooldownMinutes',
	'retries', 'retryDelayMinutes', 'timeoutMinutes', 'onlyIfChanged', 'tags',
] as const;

/** The portable part of a task. */
export function taskDefinition(job: Job): Record<string, unknown> {
	const definition: Record<string, unknown> = {};
	for (const key of DEFINITION_KEYS) {
		const value = job[key];
		if (value !== undefined && value !== null && !(Array.isArray(value) && !value.length)) definition[key] = value;
	}
	return definition;
}

export function exportTasks(jobs: Job[], now: Date = new Date()): string {
	return JSON.stringify({
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exportedAt: now.toISOString(),
		tasks: jobs.map(taskDefinition),
	}, null, 2);
}

/**
 * Turns an export file into new tasks: new ids, added paused so the user can
 * review them, and "after" links pointing at the new copies. A link to a task
 * that is not in the file is kept only if that task exists in this vault.
 * Throws with a readable message for anything that isn't an export file.
 */
export function importTasks(text: string, existing: Job[], now: Date = new Date()): Job[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('The file is not valid JSON.');
	}
	const record = parsed as { format?: unknown; tasks?: unknown };
	if (!record || record.format !== EXPORT_FORMAT || !Array.isArray(record.tasks)) {
		throw new Error('This is not an AI Scheduler task export file.');
	}
	const raw = record.tasks.filter((task): task is Record<string, unknown> =>
		!!task && typeof task === 'object' && typeof (task as Record<string, unknown>).prompt === 'string'
		&& String((task as Record<string, unknown>).prompt).trim() !== '');
	if (!raw.length) throw new Error('The file contains no tasks.');
	if (raw.length > MAX_IMPORT) throw new Error(`The file has ${raw.length} tasks; at most ${MAX_IMPORT} can be imported at once.`);

	const idMap = new Map<string, string>();
	const jobs = raw.map(task => {
		const job = normalizeJob({
			...task,
			id: undefined,
			enabled: false,
			status: 'disabled',
			nextRunAt: null,
			createdAt: now.toISOString(),
			source: 'import',
		}, now);
		if (typeof task.id === 'string') idMap.set(task.id, job.id);
		return job;
	});
	const known = new Set(existing.map(job => job.id));
	for (const job of jobs) {
		if (job.schedule.kind !== 'after' || !job.schedule.afterTask) continue;
		const target = idMap.get(job.schedule.afterTask);
		if (target) job.schedule.afterTask = target;
		else if (!known.has(job.schedule.afterTask)) delete job.schedule.afterTask;
	}
	return jobs;
}
