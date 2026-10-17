import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob } from '../src/settings';
import { TaskSchedule } from '../src/types';

const SCHEDULES: TaskSchedule[] = [
	{ kind: 'once', at: '2026-12-01T09:00:00.000Z' },
	{ kind: 'daily', time: '22:00', everyDays: 3, startAt: '2026-10-01' },
	{ kind: 'weekly', time: '09:00', days: [1, 3], everyWeeks: 2, startAt: '2026-10-05' },
	{ kind: 'monthly', time: '09:00', dayOfMonth: 15, everyMonths: 2, startAt: '2026-10-15' },
	{ kind: 'yearly', time: '08:30', dayOfMonth: 4, month: 7 },
	{ kind: 'interval', time: '08:00', intervalMinutes: 120, maxIterations: 5 },
	{ kind: 'cron', expression: '*/15 * * * *' },
	{ kind: 'event', event: 'modify' },
];

test('normalizeJob preserves every schedule field across a JSON round trip', () => {
	for (const schedule of SCHEDULES) {
		const job = normalizeJob({ title: 't', prompt: 'p', schedule });
		const reloaded = normalizeJob(JSON.parse(JSON.stringify(job)));
		assert.deepEqual(reloaded.schedule, job.schedule, `${schedule.kind} schedule changed on reload`);
		for (const [key, value] of Object.entries(schedule)) {
			assert.deepEqual(reloaded.schedule[key as keyof TaskSchedule], value, `${schedule.kind}.${key} was dropped`);
		}
	}
});

test('normalizeJob rejects out-of-range recurrence fields', () => {
	const job = normalizeJob({
		title: 't',
		prompt: 'p',
		schedule: { kind: 'yearly', time: '09:00', dayOfMonth: 32, month: 13, everyDays: 0, everyWeeks: -1, everyMonths: 1.5, startAt: 'not a date' },
	});
	assert.equal(job.schedule.dayOfMonth, undefined);
	assert.equal(job.schedule.month, undefined);
	assert.equal(job.schedule.everyDays, undefined);
	assert.equal(job.schedule.everyWeeks, undefined);
	assert.equal(job.schedule.everyMonths, undefined);
	assert.equal(job.schedule.startAt, undefined);
});

test('normalizeJob keeps valid output modes, run options and history, and drops bad values', () => {
	const job = normalizeJob({
		title: 't',
		prompt: 'p',
		schedule: { kind: 'daily', time: '09:00' },
		output: { filename: 'Log', mode: 'append', heading: 'Runs' },
		retries: 3,
		retryDelayMinutes: 15,
		timeoutMinutes: 30,
		onlyIfChanged: true,
		lastSuccessAt: '2026-10-17T09:00:00.000Z',
		history: [
			{ at: '2026-10-17T09:00:00.000Z', status: 'completed', durationMs: 1200, output: 'Log.md' },
			{ at: '2026-10-17T10:00:00.000Z', status: 'failed', error: 'boom', retry: 1 },
			{ at: 'x', status: 'exploded' },
			null,
		],
	});
	const reloaded = normalizeJob(JSON.parse(JSON.stringify(job)));
	assert.deepEqual(reloaded.output, { folder: undefined, filename: 'Log', mode: 'append', heading: 'Runs' });
	assert.equal(reloaded.retries, 3);
	assert.equal(reloaded.retryDelayMinutes, 15);
	assert.equal(reloaded.timeoutMinutes, 30);
	assert.equal(reloaded.onlyIfChanged, true);
	assert.equal(reloaded.lastSuccessAt, '2026-10-17T09:00:00.000Z');
	assert.equal(reloaded.history?.length, 2);
	assert.equal(reloaded.history?.[1].retry, 1);

	const bad = normalizeJob({
		title: 't', prompt: 'p', schedule: { kind: 'daily', time: '09:00' },
		output: { mode: 'sideways' }, retries: 9, retryDelayMinutes: 0, timeoutMinutes: -1, onlyIfChanged: 'yes',
	});
	assert.equal(bad.output?.mode, undefined);
	assert.equal(bad.retries, undefined);
	assert.equal(bad.retryDelayMinutes, undefined);
	assert.equal(bad.timeoutMinutes, undefined);
	assert.equal(bad.onlyIfChanged, undefined);
});
