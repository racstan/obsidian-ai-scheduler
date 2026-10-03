import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronFormFor, describeSchedule, getScheduleNextRun, normalizeMultiRules, previewSchedule, validClock } from '../src/schedule';
import { normalizeJob, parseStoredData, DEFAULT_SETTINGS } from '../src/settings';
import { TaskSchedule } from '../src/types';

function at(year: number, month1: number, day: number, hour = 0, minute = 0): Date {
	return new Date(year, month1 - 1, day, hour, minute, 0, 0);
}

test('getScheduleNextRun resolves every schedule kind', () => {
	const from = at(2026, 9, 5, 12, 0); // Saturday
	const once: TaskSchedule = { kind: 'once', at: at(2026, 9, 6, 9, 0).toISOString() };
	assert.equal(getScheduleNextRun(once, from), at(2026, 9, 6, 9, 0).toISOString());

	const daily: TaskSchedule = { kind: 'daily', time: '09:00' };
	assert.equal(getScheduleNextRun(daily, from), at(2026, 9, 6, 9, 0).toISOString());

	const weekly: TaskSchedule = { kind: 'weekly', time: '09:00', days: [1] };
	assert.equal(getScheduleNextRun(weekly, from), at(2026, 9, 7, 9, 0).toISOString());

	const multi: TaskSchedule = { kind: 'multi', rules: [{ days: [1], times: ['08:30'] }] };
	assert.equal(getScheduleNextRun(multi, from), at(2026, 9, 7, 8, 30).toISOString());

	const interval: TaskSchedule = { kind: 'interval', intervalMinutes: 30 };
	assert.equal(getScheduleNextRun(interval, from), new Date(from.getTime() + 30 * 60000).toISOString());

	const hourly: TaskSchedule = { kind: 'hourly' };
	assert.equal(getScheduleNextRun(hourly, from), new Date(from.getTime() + 60 * 60000).toISOString());

	const event: TaskSchedule = { kind: 'event', event: 'modify' };
	assert.equal(getScheduleNextRun(event, from), null);

	const cron: TaskSchedule = { kind: 'cron', expression: '0 9 * * 1-5' };
	assert.equal(getScheduleNextRun(cron, from), at(2026, 9, 7, 9, 0).toISOString());

	assert.equal(getScheduleNextRun({ kind: 'cron', expression: 'not a cron' }, from), null);
	assert.equal(getScheduleNextRun({ kind: 'cron' }, from), null);
});

test('getScheduleNextRun keeps legacy interval field names working', () => {
	const from = at(2026, 9, 5, 12, 0);
	assert.equal(
		getScheduleNextRun({ kind: 'interval', everyMinutes: 45 } as unknown as TaskSchedule, from),
		new Date(from.getTime() + 45 * 60000).toISOString(),
	);
	assert.equal(
		getScheduleNextRun({ kind: 'interval', everyHours: 2 } as unknown as TaskSchedule, from),
		new Date(from.getTime() + 120 * 60000).toISOString(),
	);
});

test('cronFormFor converts exactly expressible schedules', () => {
	assert.equal(cronFormFor({ kind: 'daily', time: '09:30' }), '30 9 * * *');
	assert.equal(cronFormFor({ kind: 'weekly', time: '08:05', days: [1, 3, 5] }), '5 8 * * 1,3,5');
	assert.equal(cronFormFor({ kind: 'multi', rules: [{ days: [1], times: ['02:00'] }, { days: [6], times: ['02:00'] }] }), '0 2 * * 1,6');
	// Differing times per rule cannot be a single cron expression.
	assert.equal(cronFormFor({ kind: 'multi', rules: [{ days: [1], times: ['02:00'] }, { days: [6], times: ['15:00'] }] }), null);
	assert.equal(cronFormFor({ kind: 'once', at: at(2026, 9, 6).toISOString() }), null);
	assert.equal(cronFormFor({ kind: 'event' }), null);
	assert.equal(cronFormFor({ kind: 'cron', expression: '*/15 * * * *' }), '*/15 * * * *');
});

test('previewSchedule formats concrete upcoming runs', () => {
	const runs = previewSchedule({ kind: 'daily', time: '09:00' }, 2, at(2026, 9, 5, 12, 0));
	assert.deepEqual(runs, ['2026-09-06 09:00', '2026-09-07 09:00']);
	assert.deepEqual(previewSchedule({ kind: 'event' }, 3), ['fires on vault activity']);
	assert.deepEqual(previewSchedule({ kind: 'cron', expression: '30 9 * * *' }, 1, at(2026, 9, 5, 12, 0)), ['2026-09-06 09:30']);
});

test('describeSchedule renders cron jobs with plain English and the expression', () => {
	const description = describeSchedule({ schedule: { kind: 'cron', expression: '*/15 * * * *' }, nextRunAt: null });
	assert.equal(description, 'Every 15 minutes · */15 * * * *');
	assert.match(describeSchedule({ schedule: { kind: 'cron', expression: 'garbage' }, nextRunAt: null }), /cron/);
});

test('normalizeJob accepts the cron kind and preserves legacy aliases', () => {
	const job = normalizeJob({ title: 'Tick', prompt: 'hello', schedule: { kind: 'cron', expression: '*/15 * * * *' } });
	assert.equal(job.schedule.kind, 'cron');
	assert.equal(job.schedule.expression, '*/15 * * * *');
	assert.ok(job.nextRunAt);

	const legacy = normalizeJob({ title: 'Legacy', prompt: 'x', schedule: { kind: 'interval', everyHours: 2 } });
	assert.equal(legacy.schedule.intervalMinutes, 120);

	const bounded = normalizeJob({ title: 'Runs', prompt: 'x', schedule: { kind: 'interval', intervalMinutes: 10, maxRuns: 4 } });
	assert.equal(bounded.schedule.maxIterations, 4);

	const unknownKind = normalizeJob({ title: 'Odd', prompt: 'x', schedule: { kind: 'annually' } });
	assert.equal(unknownKind.schedule.kind, 'once');
});

test('normalizeMultiRules keeps valid rules only', () => {
	const rules = normalizeMultiRules([
		{ days: [1, 9, 'x'], times: ['09:00', '25:00'] },
		{ days: [], times: ['09:00'] },
	]);
	assert.deepEqual(rules, [{ days: [1], times: ['09:00'] }]);
	assert.equal(validClock('09:60'), false);
});

test('parseStoredData applies migrations and new-setting defaults', () => {
	const parsed = parseStoredData({
		version: 2,
		settings: { backendMode: 'copilot', planningProfile: 'profile:abc', nightlyProfile: 'profile:night' },
		jobs: [{ title: 'Kept', prompt: 'p', schedule: { kind: 'daily', time: '08:00' } }],
		activity: Array.from({ length: 60 }, (_, index) => ({ id: `e${index}`, at: '', type: 'x', message: 'm' })),
	});
	assert.equal(parsed.settings.catchUpOnStart, false, 'pre-v3 installs keep catch-up off');
	assert.equal(parsed.settings.backendMode, 'copilot');
	assert.equal(parsed.settings.planningModel, 'profile:abc');
	assert.equal(parsed.settings.dailyReviewModel, 'profile:night');
	assert.equal(parsed.settings.executionModel, 'profile:abc');
	assert.equal(parsed.settings.scheduleNotesEnabled, false, 'notes storage stays opt-in');
	assert.equal(parsed.settings.scheduleFolder, DEFAULT_SETTINGS.scheduleFolder);
	assert.equal(parsed.jobs.length, 1);
	assert.equal(parsed.activity.length, 50, 'activity is capped at 50');
});

test('parseStoredData migrates the ancient tasks format', () => {
	const parsed = parseStoredData({
		version: 1,
		tasks: [{ title: 'Old', content: 'do things', sendAt: at(2026, 9, 6, 9, 0).toISOString(), status: 'pending' }],
	});
	assert.equal(parsed.jobs.length, 1);
	assert.equal(parsed.jobs[0].schedule.kind, 'once');
	assert.equal(parsed.jobs[0].prompt, 'do things');
	assert.equal(parsed.jobs[0].enabled, true);
});

test('cronFormFor multi rule emits all times', () => {
	const form = cronFormFor({
		kind: 'multi',
		rules: [
			{ days: [1, 2, 3, 4, 5], times: ['09:00', '17:00'] },
		],
	});
	assert.equal(form, '0 9,17 * * 1,2,3,4,5');
});

test('previewSchedule for once rule returns a single entry without duplicates', () => {
	const runs = previewSchedule({ kind: 'once', at: '2026-10-01T09:15:00.000Z' }, 3);
	assert.equal(runs.length, 1);
});

test('normalizeJob sanitizes corrupted or stringified persisted fields', () => {
	const job = normalizeJob({
		enabled: 'false',
		status: 'banana',
		taskNumber: 'abc',
		attempts: 'x',
		contextPaths: 'not-an-array',
	});
	assert.equal(job.enabled, false);
	assert.equal(job.status, 'disabled');
	assert.equal(job.taskNumber, 0);
	assert.equal(job.attempts, 0);
	assert.deepEqual(job.contextPaths, []);
});

test('extended cadences calculate correct next runs and descriptions', () => {
	const from = at(2026, 10, 3, 10, 0); // Saturday Oct 3, 2026, 10:00

	// Every 3 days at 09:00
	const every3Days: TaskSchedule = { kind: 'daily', time: '09:00', everyDays: 3 };
	assert.equal(getScheduleNextRun(every3Days, from), at(2026, 10, 6, 9, 0).toISOString());
	assert.equal(describeSchedule({ schedule: every3Days }), 'every 3 days at 09:00');

	// Every 2 weeks on Monday at 09:00 with startAt
	const every2Weeks: TaskSchedule = { kind: 'weekly', time: '09:00', days: [1], everyWeeks: 2, startAt: '2026-10-05T00:00:00.000Z' };
	assert.equal(getScheduleNextRun(every2Weeks, from), at(2026, 10, 5, 9, 0).toISOString());
	assert.equal(describeSchedule({ schedule: every2Weeks }), 'every 2 weeks on Mon at 09:00');

	// Monthly on 15th at 14:00 every 2 months
	const monthly: TaskSchedule = { kind: 'monthly', time: '14:00', dayOfMonth: 15, everyMonths: 2 };
	assert.equal(getScheduleNextRun(monthly, from), at(2026, 10, 15, 14, 0).toISOString());
	assert.equal(describeSchedule({ schedule: monthly }), 'every 2 months on day 15 at 14:00');

	// Yearly on December 25th at 08:00
	const yearly: TaskSchedule = { kind: 'yearly', time: '08:00', month: 12, dayOfMonth: 25, maxIterations: 5 };
	assert.equal(getScheduleNextRun(yearly, from), at(2026, 12, 25, 8, 0).toISOString());
	assert.equal(describeSchedule({ schedule: yearly }), 'yearly on December 25 at 08:00 · runs for 5 times then done');

	// Interval with initial time anchor
	const intervalWithTime: TaskSchedule = { kind: 'interval', intervalMinutes: 15, time: '14:00' };
	const nextRun = getScheduleNextRun(intervalWithTime, from);
	assert.equal(nextRun, at(2026, 10, 3, 14, 0).toISOString());
});

