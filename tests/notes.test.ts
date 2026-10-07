import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleNotesSync, definitionFromContent } from '../src/notes';
import { DEFAULT_SETTINGS, normalizeJob } from '../src/settings';

function notesSync() {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, scheduleNotesEnabled: true },
		jobs: [],
		app: { vault: { getAbstractFileByPath: () => null } },
	};
	return new ScheduleNotesSync(plugin as unknown as ConstructorParameters<typeof ScheduleNotesSync>[0]);
}

test('a schedule note round-trips every schedule field through its frontmatter', () => {
	const job = normalizeJob({
		title: 'Monthly report',
		prompt: 'Summarize the month',
		schedule: { kind: 'monthly', time: '09:00', dayOfMonth: 15, everyMonths: 2, startAt: '2026-10-15' },
		output: { folder: 'Reports' },
	});
	const definition = definitionFromContent(notesSync().renderNote(job));
	assert.ok(definition, 'frontmatter definition found');
	const reloaded = normalizeJob({ title: definition.title, prompt: definition.prompt, schedule: definition.schedule });
	assert.deepEqual(reloaded.schedule, job.schedule);
	assert.equal(definition.prompt, 'Summarize the month');
});

test('definitionFromContent ignores notes without (or with broken) frontmatter', () => {
	assert.equal(definitionFromContent('# Just a note'), null);
	assert.equal(definitionFromContent('---\n{ not json\n---\nbody'), null);
	assert.equal(definitionFromContent('---\n{"other": 1}\n---\n'), null);
});

test('isInside matches the folder and its children only', () => {
	assert.ok(ScheduleNotesSync.isInside('AI Schedules', 'AI Schedules/a.md'));
	assert.ok(!ScheduleNotesSync.isInside('AI Schedules', 'AI Schedules Old/a.md'));
});
