import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueJobs, planStartupCatchUp, reconcileAfterRun, recoverInterruptedRuns, skipMissedJob } from '../src/engine';
import { normalizeJob } from '../src/settings';
import { Job } from '../src/types';

function makeJob(overrides: Record<string, unknown>): Job {
	return normalizeJob({ title: 'Task', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, ...overrides });
}

test('dueJobs returns enabled jobs whose next run has passed, oldest first', () => {
	const now = Date.now();
	const due1 = makeJob({ nextRunAt: new Date(now - 60_000).toISOString() });
	const due2 = makeJob({ nextRunAt: new Date(now - 30_000).toISOString() });
	const future = makeJob({ nextRunAt: new Date(now + 60_000).toISOString() });
	const disabled = makeJob({ enabled: false, nextRunAt: new Date(now - 90_000).toISOString() });
	const due = dueJobs([due2, future, disabled, due1], now);
	assert.deepEqual(due.map(job => job.id), [due1.id, due2.id]);
});

test('reconcileAfterRun ends once and event jobs and reschedules recurring ones', () => {
	const once = makeJob({ schedule: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() }, nextRunAt: new Date().toISOString() });
	reconcileAfterRun(once);
	assert.equal(once.enabled, false);
	assert.equal(once.nextRunAt, null);

	const event = makeJob({ schedule: { kind: 'event' }, nextRunAt: new Date().toISOString() });
	reconcileAfterRun(event);
	assert.equal(event.nextRunAt, null);
	assert.equal(event.enabled, true);

	const recurring = makeJob({ schedule: { kind: 'daily', time: '09:00' } });
	recurring.runCount = 1;
	reconcileAfterRun(recurring);
	assert.equal(recurring.enabled, true);
	assert.ok(recurring.nextRunAt && new Date(recurring.nextRunAt).getTime() > Date.now());
});

test('reconcileAfterRun retires jobs that exhausted their iteration budget', () => {
	const job = makeJob({ schedule: { kind: 'interval', intervalMinutes: 10, maxIterations: 3 } });
	job.runCount = 3;
	reconcileAfterRun(job);
	assert.equal(job.enabled, false);
	assert.equal(job.nextRunAt, null);
	assert.equal(job.status, 'completed');

	const failed = makeJob({ schedule: { kind: 'interval', intervalMinutes: 10, maxIterations: 3 } });
	failed.runCount = 3;
	failed.status = 'failed';
	reconcileAfterRun(failed, { failed: true });
	assert.equal(failed.enabled, false);
	assert.equal(failed.status, 'failed', 'failure path keeps the failure status');
});

test('skipMissedJob marks once jobs missed and reschedules recurring ones', () => {
	const once = makeJob({ schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() }, nextRunAt: new Date(Date.now() - 60_000).toISOString() });
	skipMissedJob(once);
	assert.equal(once.status, 'missed');
	assert.equal(once.enabled, false);

	const recurring = makeJob({ schedule: { kind: 'daily', time: '09:00' }, nextRunAt: new Date(Date.now() - 60_000).toISOString() });
	skipMissedJob(recurring);
	assert.equal(recurring.enabled, true);
	assert.ok(recurring.nextRunAt && new Date(recurring.nextRunAt).getTime() > Date.now());

	const exhausted = makeJob({ schedule: { kind: 'interval', intervalMinutes: 10, maxIterations: 2 } });
	exhausted.runCount = 2;
	skipMissedJob(exhausted);
	assert.equal(exhausted.status, 'completed');
	assert.equal(exhausted.enabled, false);
});

test('startup catch-up honours the settings toggle and window', () => {
	const now = Date.now();
	const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
	const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
	const jobs = [
		makeJob({ id: 'recent', nextRunAt: hourAgo }),
		makeJob({ id: 'ancient', nextRunAt: weekAgo }),
	];

	const off = planStartupCatchUp(jobs, { catchUpOnStart: false, catchUpHours: 24 }, now);
	assert.equal(off.missed.length, 0);
	assert.equal(off.stale.length, 2, 'with catch-up off, everything is reconciled as skipped');

	const on = planStartupCatchUp(jobs, { catchUpOnStart: true, catchUpHours: 24 }, now);
	assert.deepEqual(on.missed.map(job => job.id), ['recent']);
	assert.deepEqual(on.stale.map(job => job.id), ['ancient']);
});

test('recoverInterruptedRuns resets crashed runs without double-billing recurring work', () => {
	const recurring = makeJob({ schedule: { kind: 'daily', time: '09:00' }, status: 'running', nextRunAt: new Date(Date.now() - 60_000).toISOString() });
	const once = makeJob({ schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() }, status: 'running', nextRunAt: new Date(Date.now() - 60_000).toISOString() });
	const healthy = makeJob({ status: 'scheduled' });
	const originalOnceSlot = once.nextRunAt;
	const recovered = recoverInterruptedRuns([recurring, once, healthy]);
	assert.equal(recovered, 2);
	assert.equal(recurring.status, 'scheduled');
	assert.ok(recurring.nextRunAt && new Date(recurring.nextRunAt).getTime() > Date.now(), 'recurring job gets a fresh future slot');
	assert.equal(once.nextRunAt, originalOnceSlot, 'once job keeps its original slot for catch-up');
	assert.equal(once.status, 'scheduled');
	assert.equal(healthy.status, 'scheduled');
});
