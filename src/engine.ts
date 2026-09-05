/*
 * Pure scheduling-engine logic so the dispatcher decisions are unit-testable:
 * which jobs are due, what happens to a job after a run, how missed runs are
 * reconciled at startup, and recovery of runs interrupted by a crash.
 */
import { AISettings, Job } from './types';
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
	const cutoff = now - Number(settings.catchUpHours || 24) * 60 * 60 * 1000;
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

/** Recomputes the next run for a (re-)enabled non-event job. */
export function rescheduleEnabledJob(job: Job): void {
	job.nextRunAt = job.schedule.kind === 'event'
		? new Date().toISOString()
		: getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
}
