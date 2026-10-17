import { Job } from './types';

/** A one-time plan whose time has already passed (e.g. "at 12 pm today" asked at 1:30 pm). */
export function isPastOncePlan(plan: Record<string, unknown>, now: Date = new Date()): boolean {
	const schedule = plan.schedule as { kind?: unknown; at?: unknown } | null | undefined;
	if (!schedule || (schedule.kind !== undefined && schedule.kind !== 'once') || typeof schedule.at !== 'string') return false;
	const at = new Date(schedule.at).getTime();
	return Number.isFinite(at) && at <= now.getTime();
}

/** The same clock time on the first day it is still ahead (at least a minute from now). */
export function nextFutureTime(at: string, now: Date = new Date()): string {
	const date = new Date(at);
	while (date.getTime() <= now.getTime() + 60_000) date.setDate(date.getDate() + 1);
	return date.toISOString();
}

/** A copy of the plan moved to the next day its time is still ahead. */
export function movePlanToFuture(plan: Record<string, unknown>, now: Date = new Date()): Record<string, unknown> {
	const schedule = plan.schedule as { at: string };
	return { ...plan, schedule: { ...schedule, kind: 'once', at: nextFutureTime(schedule.at, now) } };
}

/** The start of an AI reply, without scheduler tags or code fences, for error messages. */
export function replyExcerpt(reply: string, length = 240): string {
	const text = String(reply || '')
		.replace(/<\/?assistant-scheduler>/gi, ' ')
		.replace(/```[a-z]*/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

/** Every task the AI planned is a one-time task in the past; `reschedule` creates them on the next day instead. */
export class PastTimePlanError extends Error {
	constructor(
		/** The requested (past) times, ISO. */
		readonly times: string[],
		/** The times they would move to. */
		readonly nextTimes: string[],
		readonly reschedule: () => Promise<Job[]>,
	) {
		super(times.length === 1
			? 'The requested time has already passed.'
			: 'The requested times have already passed.');
		this.name = 'PastTimePlanError';
	}
}
