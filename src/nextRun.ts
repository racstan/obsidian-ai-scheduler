import { AISettings, Job } from './types';
import { inQuietHours, quietHoursEnd, startBlockReason } from './engine';
import { waitsForTrigger } from './schedule';

type NextRunSettings = Pick<AISettings, 'paused' | 'pausedUntil' | 'quietHoursEnabled' | 'quietStart' | 'quietEnd'>;

/** What the dashboard's "Next run" box shows. */
export interface NextRunSummary {
	/** Tasks running right now. */
	running: Job[];
	/** When the next timed run is due, or null when nothing is timed. */
	nextAt: string | null;
	/** True when the next run's time has already passed. */
	overdue: boolean;
	/** Every task due at `nextAt` (the same minute), or every overdue task. */
	next: Job[];
	/** Enabled tasks that only start from a trigger (note changes or another task). */
	waitingForTrigger: number;
	/** Why the next run will not start on time, and when it can. */
	hold: { reason: 'paused' | 'quiet'; until: string | null } | null;
}

const minuteKey = (time: number): number => Math.floor(time / 60_000);

export function summarizeNextRun(jobs: Job[], runningIds: Set<string>, settings: NextRunSettings, now: Date = new Date()): NextRunSummary {
	const isRunning = (job: Job) => job.status === 'running' || runningIds.has(job.id);
	const running = jobs.filter(isRunning);
	const timed = jobs
		.filter(job => job.enabled && !isRunning(job) && !waitsForTrigger(job.schedule) && job.nextRunAt
			&& Number.isFinite(new Date(job.nextRunAt).getTime()))
		.sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime()
			|| (a.taskNumber || 0) - (b.taskNumber || 0));
	const waitingForTrigger = jobs.filter(job => job.enabled && !isRunning(job) && waitsForTrigger(job.schedule)).length;

	if (!timed.length) return { running, nextAt: null, overdue: false, next: [], waitingForTrigger, hold: null };

	const first = new Date(timed[0].nextRunAt as string).getTime();
	const overdue = first <= now.getTime();
	const next = overdue
		? timed.filter(job => new Date(job.nextRunAt as string).getTime() <= now.getTime())
		: timed.filter(job => minuteKey(new Date(job.nextRunAt as string).getTime()) === minuteKey(first));

	let hold: NextRunSummary['hold'] = null;
	const block = startBlockReason(settings, now);
	if (block === 'paused') {
		hold = { reason: 'paused', until: settings.pausedUntil || null };
	} else if (block === 'quiet') {
		hold = { reason: 'quiet', until: quietHoursEnd(now, settings.quietEnd).toISOString() };
	} else if (!overdue && settings.quietHoursEnabled && inQuietHours(new Date(first), settings.quietStart, settings.quietEnd)) {
		hold = { reason: 'quiet', until: quietHoursEnd(new Date(first), settings.quietEnd).toISOString() };
	}

	return { running, nextAt: timed[0].nextRunAt, overdue, next, waitingForTrigger, hold };
}

/** "A", "A and B", "A, B and 3 more". */
export function listTitles(jobs: Job[], shown = 2): string {
	const titles = jobs.map(job => job.title || 'Untitled task');
	if (titles.length <= shown) return titles.length === 2 ? `${titles[0]} and ${titles[1]}` : titles.join(', ');
	return `${titles.slice(0, shown).join(', ')} and ${titles.length - shown} more`;
}
