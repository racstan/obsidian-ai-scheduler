/*
 * Pure scheduling-engine logic so the dispatcher decisions are unit-testable:
 * which jobs are due, what happens to a job after a run, how missed runs are
 * reconciled at startup, and recovery of runs interrupted by a crash.
 */
import { AISettings, Job, RunRecord } from './types';
import { getScheduleNextRun } from './schedule';

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
	} else if (job.schedule.kind === 'event') {
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
	} else if (job.schedule.kind === 'event') {
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
		if (job.schedule.kind !== 'event' && job.schedule.kind !== 'once') {
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
	job.nextRunAt = job.schedule.kind === 'event'
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
