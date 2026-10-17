/*
 * Pure scheduling-engine logic so the dispatcher decisions are unit-testable:
 * which jobs are due, what happens to a job after a run, how missed runs are
 * reconciled at startup, and recovery of runs interrupted by a crash.
 */
import { AISettings, Job, RunRecord } from './types';
import { getScheduleNextRun, waitsForTrigger } from './schedule';

/** Jobs whose next run is due, oldest first. */
export function dueJobs(jobs: Job[], now: number): Job[] {
	return jobs
		.filter(job => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now)
		.sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime());
}

/* Shared end-of-run bookkeeping for the success and failure paths: once and
 * event jobs end, recurring jobs reschedule, and jobs that exhausted their
 * iteration budget retire. */
export function reconcileAfterRun(job: Job, options: { failed?: boolean } = {}): void {
	if (job.schedule.kind === 'once') {
		job.enabled = false;
		job.nextRunAt = null;
	} else if (waitsForTrigger(job.schedule)) {
		job.nextRunAt = null;
	} else if (job.schedule.maxIterations && job.runCount >= Number(job.schedule.maxIterations)) {
		job.enabled = false;
		job.nextRunAt = null;
		if (!options.failed) job.status = 'completed';
	} else {
		job.nextRunAt = getScheduleNextRun(job.schedule, new Date());
	}
}

export function skipMissedJob(job: Job): void {
	if (job.schedule.kind === 'once') {
		job.enabled = false;
		job.nextRunAt = null;
		job.status = 'missed';
		job.lastStatus = 'missed';
	} else if (waitsForTrigger(job.schedule)) {
		job.nextRunAt = null;
	} else {
		if (job.schedule.maxIterations && job.runCount >= Number(job.schedule.maxIterations)) {
			job.enabled = false;
			job.nextRunAt = null;
			job.status = 'completed';
		} else {
			job.nextRunAt = getScheduleNextRun(job.schedule, new Date());
		}
	}
}

export interface CatchUpPlan {
	/** Missed within the configured window and eligible to run now. */
	missed: Job[];
	/** Older than the window; reconciled as skipped. */
	stale: Job[];
}

export function planStartupCatchUp(jobs: Job[], settings: Pick<AISettings, 'catchUpOnStart' | 'catchUpHours'>, now: number): CatchUpPlan {
	const due = jobs.filter(job => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now);
	if (!settings.catchUpOnStart) {
		return { missed: [], stale: due };
	}
	const raw = Number(settings.catchUpHours);
	const hours = Number.isFinite(raw) && raw >= 0 ? raw : 24;
	const cutoff = now - hours * 60 * 60 * 1000;
	return {
		missed: due.filter(job => new Date(job.nextRunAt as string).getTime() >= cutoff),
		stale: due.filter(job => new Date(job.nextRunAt as string).getTime() < cutoff),
	};
}

/* A crash mid-run used to leave a job parked in status 'running'. Reset those
 * to 'scheduled'. Recurring jobs get a fresh next-run slot (the interrupted
 * attempt counts as consumed, so AI work is never double-billed); once jobs
 * keep their original time, letting the startup catch-up rules decide.
 * Returns the number of recovered jobs. */
export function recoverInterruptedRuns(jobs: Job[]): number {
	let recovered = 0;
	for (const job of jobs) {
		if (job.status !== 'running') continue;
		job.status = 'scheduled';
		if (!waitsForTrigger(job.schedule) && job.schedule.kind !== 'once') {
			const next = getScheduleNextRun(job.schedule, new Date());
			if (next) job.nextRunAt = next;
		}
		recovered += 1;
	}
	return recovered;
}

/** Recomputes the next run for a (re-)enabled job. Event jobs wait for their
 * next vault event instead of firing the moment they are enabled. */
export function rescheduleEnabledJob(job: Job): void {
	job.nextRunAt = waitsForTrigger(job.schedule)
		? null
		: getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
}

/** How many runs a task's history keeps. */
export const HISTORY_LIMIT = 20;
export const MAX_RETRIES = 5;
export const DEFAULT_RETRY_DELAY_MINUTES = 5;

/** Adds a run to the task's history, dropping the oldest beyond the limit. */
export function recordRun(job: Job, record: RunRecord): void {
	job.history = [...(job.history ?? []), record].slice(-HISTORY_LIMIT);
}

/**
 * After a failed run: if the task has retries left, schedule the next attempt
 * and return its number (1 = first retry). Otherwise reset the count and
 * return 0, and the caller applies the normal end-of-run rules.
 */
export function planRetry(job: Job, now: number): number {
	const allowed = Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number(job.retries) || 0)));
	const used = Math.max(0, Math.floor(Number(job.retryCount) || 0));
	if (used >= allowed || !job.enabled) {
		job.retryCount = 0;
		return 0;
	}
	const rawDelay = Number(job.retryDelayMinutes);
	const delay = Number.isFinite(rawDelay) && rawDelay >= 1 ? rawDelay : DEFAULT_RETRY_DELAY_MINUTES;
	job.retryCount = used + 1;
	job.nextRunAt = new Date(now + delay * 60000).toISOString();
	job.status = 'scheduled';
	return job.retryCount;
}

/** True if `path` is `scope` or inside the folder `scope`. */
function within(path: string, scope: string): boolean {
	return path === scope || path.startsWith(`${scope.replace(/\/+$/, '')}/`);
}

/**
 * Paths of the files changed after `since`, newest first. With a `scope`
 * (attached notes and folders) only files in it count; `exclude` lists
 * folders and files the plugin writes itself, so its own output never counts
 * as a change.
 */
export function filesChangedSince(
	files: { path: string; mtime: number }[],
	since: number,
	scope: string[],
	exclude: string[],
): string[] {
	return files
		.filter(file => file.mtime > since)
		.filter(file => !scope.length || scope.some(entry => within(file.path, entry)))
		.filter(file => !exclude.some(entry => entry && within(file.path, entry)))
		.sort((a, b) => b.mtime - a.mtime)
		.map(file => file.path);
}

function clockMinutes(clock: string): number {
	const [hours, minutes] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

/**
 * True when `now` falls in the daily quiet hours from `start` to `end`
 * (HH:MM, local time). The window may pass midnight (23:00-07:00); equal
 * start and end mean no quiet hours.
 */
export function inQuietHours(now: Date, start: string, end: string): boolean {
	const from = clockMinutes(start);
	const to = clockMinutes(end);
	if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
	const current = now.getHours() * 60 + now.getMinutes();
	return from < to ? current >= from && current < to : current >= from || current < to;
}

/** When the quiet hours that contain `now` end. */
export function quietHoursEnd(now: Date, end: string): Date {
	const result = new Date(now.getTime());
	const to = clockMinutes(end);
	result.setHours(Math.floor(to / 60), to % 60, 0, 0);
	if (result.getTime() <= now.getTime()) result.setDate(result.getDate() + 1);
	return result;
}

/** Why tasks may not start on their own right now, or null when they may. */
export function startBlockReason(
	settings: Pick<AISettings, 'paused' | 'pausedUntil' | 'quietHoursEnabled' | 'quietStart' | 'quietEnd'>,
	now: Date,
): 'paused' | 'quiet' | null {
	if (settings.paused && !(settings.pausedUntil && new Date(settings.pausedUntil).getTime() <= now.getTime())) return 'paused';
	if (settings.quietHoursEnabled && inQuietHours(now, settings.quietStart, settings.quietEnd)) return 'quiet';
	return null;
}

/** Enabled tasks that run after `finished` completes successfully. */
export function chainedJobs(jobs: Job[], finished: Job): Job[] {
	return jobs.filter(job => job.enabled && job.id !== finished.id
		&& job.schedule.kind === 'after' && job.schedule.afterTask === finished.id);
}

/**
 * True if making `job` run after `afterTask` would form a loop (the task
 * would, directly or through others, end up waiting for itself).
 */
export function createsChainLoop(jobs: Job[], jobId: string, afterTask: string): boolean {
	const byId = new Map(jobs.map(job => [job.id, job]));
	const seen = new Set<string>();
	let current: string | undefined = afterTask;
	while (current) {
		if (current === jobId) return true;
		if (seen.has(current)) return false; // an existing loop elsewhere, not through this task
		seen.add(current);
		const next = byId.get(current);
		current = next && next.schedule.kind === 'after' ? next.schedule.afterTask : undefined;
	}
	return false;
}
