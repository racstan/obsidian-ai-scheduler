import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainedJobs, createsChainLoop, inQuietHours, quietHoursEnd, startBlockReason } from '../src/engine';
import { DEFAULT_SETTINGS, normalizeJob, normalizeTags, parseStoredData } from '../src/settings';
import { describeSchedule, getScheduleNextRun, setTaskTitleLookup, waitsForTrigger } from '../src/schedule';
import { exportTasks, importTasks } from '../src/transfer';
import { sortTasks, taskMatches } from '../src/taskFilter';
import { TASK_TEMPLATES } from '../src/templates';
import { expandVariables } from '../src/variables';
import { Job } from '../src/types';

function job(overrides: Record<string, unknown> = {}): Job {
	return normalizeJob({ title: 'Task', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, ...overrides });
}

const at = (hours: number, minutes = 0) => new Date(2026, 9, 17, hours, minutes);

test('quiet hours handle windows inside a day and across midnight', () => {
	assert.equal(inQuietHours(at(23, 30), '23:00', '07:00'), true);
	assert.equal(inQuietHours(at(3), '23:00', '07:00'), true);
	assert.equal(inQuietHours(at(7), '23:00', '07:00'), false, 'the end time is no longer quiet');
	assert.equal(inQuietHours(at(12), '23:00', '07:00'), false);
	assert.equal(inQuietHours(at(13), '12:00', '14:00'), true);
	assert.equal(inQuietHours(at(15), '12:00', '14:00'), false);
	assert.equal(inQuietHours(at(12), '12:00', '12:00'), false, 'equal times mean no quiet hours');
});

test('quietHoursEnd is the next end time', () => {
	assert.deepEqual(quietHoursEnd(at(23, 30), '07:00'), new Date(2026, 9, 18, 7, 0));
	assert.deepEqual(quietHoursEnd(at(3), '07:00'), at(7));
});

test('startBlockReason: paused (until it expires), then quiet hours', () => {
	const base = { ...DEFAULT_SETTINGS };
	assert.equal(startBlockReason(base, at(12)), null);
	assert.equal(startBlockReason({ ...base, paused: true }, at(12)), 'paused');
	assert.equal(startBlockReason({ ...base, paused: true, pausedUntil: at(13).toISOString() }, at(12)), 'paused');
	assert.equal(startBlockReason({ ...base, paused: true, pausedUntil: at(11).toISOString() }, at(12)), null, 'an expired pause no longer blocks');
	assert.equal(startBlockReason({ ...base, quietHoursEnabled: true }, at(23, 30)), 'quiet');
	assert.equal(startBlockReason({ ...base, quietHoursEnabled: false }, at(23, 30)), null);
});

test('pause and quiet-hours settings are validated on load', () => {
	const { settings } = parseStoredData({ version: 6, settings: { paused: true, pausedUntil: 'nonsense', quietStart: '25:00', quietEnd: '06:30', statusBarNextRun: false } });
	assert.equal(settings.paused, true);
	assert.equal(settings.pausedUntil, null);
	assert.equal(settings.quietStart, '23:00');
	assert.equal(settings.quietEnd, '06:30');
	assert.equal(settings.statusBarNextRun, false);
	const fresh = parseStoredData(null).settings;
	assert.equal(fresh.paused, false);
	assert.equal(fresh.quietHoursEnabled, false);
	assert.equal(fresh.statusBarNextRun, true);
});

test('"after" schedules wait for their task and describe it', () => {
	const first = job({ title: 'Collect' });
	const second = job({ title: 'Summarize', schedule: { kind: 'after', afterTask: first.id } });
	assert.equal(waitsForTrigger(second.schedule), true);
	assert.equal(getScheduleNextRun(second.schedule), null);
	assert.equal(second.nextRunAt, null);
	setTaskTitleLookup(id => (id === first.id ? first.title : undefined));
	assert.equal(describeSchedule(second), 'after "Collect" finishes');
	assert.equal(describeSchedule(job({ schedule: { kind: 'after', afterTask: 'gone' } })), 'after a task that no longer exists');
	setTaskTitleLookup(() => undefined);
});

test('chainedJobs finds the enabled tasks waiting for a finished one', () => {
	const first = job();
	const next = job({ schedule: { kind: 'after', afterTask: first.id } });
	const paused = job({ enabled: false, schedule: { kind: 'after', afterTask: first.id } });
	const other = job({ schedule: { kind: 'after', afterTask: 'someone-else' } });
	assert.deepEqual(chainedJobs([first, next, paused, other], first).map(j => j.id), [next.id]);
});

test('createsChainLoop refuses self-references and longer loops', () => {
	const a = job();
	const b = job({ schedule: { kind: 'after', afterTask: a.id } });
	const c = job({ schedule: { kind: 'after', afterTask: b.id } });
	const jobs = [a, b, c];
	assert.equal(createsChainLoop(jobs, a.id, a.id), true, 'a task cannot run after itself');
	assert.equal(createsChainLoop(jobs, a.id, c.id), true, 'a → c → b → a');
	assert.equal(createsChainLoop(jobs, 'new-task', c.id), false);
	assert.equal(createsChainLoop(jobs, c.id, a.id), false);
});

test('previous_result and previous_output come from the earlier task', () => {
	const context = {
		now: at(9),
		format: (date: Date) => date.toISOString(),
		taskTitle: 'Summarize',
		lastRun: null,
		previous: () => ({ reply: ' The collected notes \n', output: 'AI Scheduler/Collected.md' }),
	};
	assert.equal(expandVariables('Use: {{previous_result}}', context), 'Use: The collected notes');
	assert.equal(expandVariables('See {{previous_output}}', context), 'See [[AI Scheduler/Collected]]');
	assert.equal(expandVariables('{{previous_output}} summary', context, true), 'Collected summary');
	assert.equal(expandVariables('{{previous_result}}', { ...context, previous: () => null }), '(the previous task has no result yet)');
	assert.equal(expandVariables('{{previous_result}}', { ...context, previous: undefined }), '{{previous_result}}');
});

test('tags are cleaned up: no #, no duplicates, spaces become dashes', () => {
	assert.deepEqual(normalizeTags(['#work', 'Work', ' deep focus ', '', 'review']), ['work', 'deep-focus', 'review']);
	assert.deepEqual(normalizeTags('a, #b, a'), ['a', 'b']);
	assert.equal(normalizeTags([]), undefined);
	assert.deepEqual(job({ tags: ['x'] }).tags, ['x']);
});

test('export and import keep the definition, add tasks paused and relink chains', () => {
	const first = job({ title: 'Collect', tags: ['work'], retries: 2, output: { mode: 'daily' } });
	first.history = [{ at: at(9).toISOString(), status: 'completed' }];
	first.lastReply = 'secret reply';
	const second = job({ title: 'Summarize', schedule: { kind: 'after', afterTask: first.id } });
	const file = exportTasks([first, second], at(10));
	assert.ok(!file.includes('secret reply'), 'replies stay behind');
	assert.ok(!file.includes('history'), 'run history stays behind');

	const imported = importTasks(file, []);
	assert.equal(imported.length, 2);
	const [copyA, copyB] = imported;
	assert.notEqual(copyA.id, first.id, 'imported tasks get new ids');
	assert.equal(copyA.enabled, false);
	assert.equal(copyA.status, 'disabled');
	assert.deepEqual(copyA.tags, ['work']);
	assert.equal(copyA.retries, 2);
	assert.deepEqual(copyA.output, { folder: undefined, filename: undefined, mode: 'daily' });
	assert.equal(copyB.schedule.afterTask, copyA.id, 'chain points at the imported copy');
});

test('import drops a chain to a task that is not in the file or the vault', () => {
	const lone = job({ schedule: { kind: 'after', afterTask: 'elsewhere' } });
	const kept = job({ schedule: { kind: 'after', afterTask: 'existing' } });
	const existing = job();
	existing.id = 'existing';
	const imported = importTasks(exportTasks([lone, kept]), [existing]);
	assert.equal(imported[0].schedule.afterTask, undefined);
	assert.equal(imported[1].schedule.afterTask, 'existing');
});

test('import rejects files that are not task exports', () => {
	assert.throws(() => importTasks('not json', []), /not valid JSON/);
	assert.throws(() => importTasks('{"tasks":[]}', []), /not an AI Scheduler task export/);
	assert.throws(() => importTasks('{"format":"ai-scheduler-tasks","tasks":[{"title":"x"}]}', []), /no tasks/);
});

test('search matches every word in title, instructions, tags and #number', () => {
	const a = job({ title: 'Weekly review', prompt: 'Summarize projects', tags: ['work'] });
	a.taskNumber = 7;
	assert.equal(taskMatches(a, '', ''), true);
	assert.equal(taskMatches(a, 'weekly projects', ''), true);
	assert.equal(taskMatches(a, '#7', ''), true);
	assert.equal(taskMatches(a, '#work', ''), true);
	assert.equal(taskMatches(a, 'weekly missing', ''), false);
	assert.equal(taskMatches(a, '', 'WORK'), true, 'tag filter ignores case');
	assert.equal(taskMatches(a, '', 'home'), false);
});

test('sortTasks orders by next run, title, number or last run', () => {
	const later = job({ title: 'B', nextRunAt: at(12).toISOString(), lastRunAt: at(8).toISOString() });
	const sooner = job({ title: 'A', nextRunAt: at(10).toISOString(), lastRunAt: at(9).toISOString() });
	const none = job({ title: 'C', nextRunAt: null });
	later.taskNumber = 1; sooner.taskNumber = 2; none.taskNumber = 3;
	assert.deepEqual(sortTasks([none, later, sooner], 'next').map(j => j.title), ['A', 'B', 'C']);
	assert.deepEqual(sortTasks([none, later, sooner], 'title').map(j => j.title), ['A', 'B', 'C']);
	assert.deepEqual(sortTasks([none, sooner, later], 'number').map(j => j.title), ['B', 'A', 'C']);
	assert.deepEqual(sortTasks([none, later, sooner], 'recent').map(j => j.title), ['A', 'B', 'C']);
});

test('every template makes a valid task', () => {
	const ids = new Set<string>();
	for (const template of TASK_TEMPLATES) {
		assert.ok(!ids.has(template.id), `duplicate template id ${template.id}`);
		ids.add(template.id);
		const made = job({ title: template.title, prompt: template.prompt, schedule: template.schedule, output: template.output ?? null });
		assert.ok(made.nextRunAt, `${template.id} has a next run`);
		assert.ok(made.prompt.length > 20, `${template.id} has instructions`);
	}
});
