import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataviewQueries, expandDataviewQueries, fillTemplate, formatAsTasks, replaceDataviewQueries } from '../src/integrations';
import { editTargetPath, extractEdits, foldDiff, lineDiff, normalizePendingChanges } from '../src/approval';
import { normalizeJob, parseStoredData } from '../src/settings';
import type { App } from 'obsidian';

const fakeApp = (plugins: Record<string, unknown>) => ({ plugins: { plugins } }) as unknown as App;

test('Dataview queries are found, run and put in place', async () => {
	const text = 'Review these:\n{{dataview: LIST FROM #project}}\nand {{ dataview : TABLE file.mtime FROM "Inbox" }}';
	assert.deepEqual(dataviewQueries(text), ['LIST FROM #project', 'TABLE file.mtime FROM "Inbox"']);
	assert.equal(replaceDataviewQueries('a {{dataview: X}} b', ['R']), 'a R b');
	const asked: string[] = [];
	const app = fakeApp({ dataview: { api: { queryMarkdown: async (query: string) => {
		asked.push(query);
		return query.startsWith('LIST') ? { successful: true, value: '- [[One]]\n- [[Two]]' } : { successful: false, error: 'bad query' };
	} } } });
	const expanded = await expandDataviewQueries(app, text);
	assert.deepEqual(asked, ['LIST FROM #project', 'TABLE file.mtime FROM "Inbox"']);
	assert.match(expanded, /- \[\[One\]\]\n- \[\[Two\]\]/);
	assert.match(expanded, /\(Dataview query failed: bad query\)/);
	assert.match(await expandDataviewQueries(fakeApp({}), 'x {{dataview: LIST}}'), /Dataview is not installed or enabled/);
	assert.equal(await expandDataviewQueries(fakeApp({}), 'no queries'), 'no queries');
});

test('task lines are made consistent for the Tasks plugin', () => {
	const reply = 'Summary\n* [ ] Call Sam\n-[] Email Jo 📅 2026-10-20\n  + [x] Done thing\n- normal bullet\n```\n- [ ] in code\n```';
	assert.equal(formatAsTasks(reply, '#ai'), 'Summary\n- [ ] Call Sam #ai\n- [ ] Email Jo 📅 2026-10-20 #ai\n  - [x] Done thing\n- normal bullet\n```\n- [ ] in code\n```');
	assert.equal(formatAsTasks('- [ ] Has #ai already', 'ai'), '- [ ] Has #ai already');
	assert.equal(formatAsTasks('- [ ] No tag'), '- [ ] No tag');
});

test('templates take the result where {{result}} is, or at the end', () => {
	assert.equal(fillTemplate('# Summary\n\n{{result}}\n\n---', 'R'), '# Summary\n\nR\n\n---');
	assert.equal(fillTemplate('# Summary\n', 'R'), '# Summary\n\nR');
	assert.equal(fillTemplate('', 'R'), 'R');
	assert.equal(fillTemplate('{{result}}', '$& $1'), '$& $1', 'replacement patterns in the result are kept as text');
});

test('proposed edits are split from the reply and their paths checked', () => {
	const reply = 'Done.\n<ai-scheduler-edit path="Projects/Plan.md">\n# Plan\nNew text\n</ai-scheduler-edit>\nAlso see above.';
	const { edits, rest } = extractEdits(reply);
	assert.deepEqual(edits, [{ path: 'Projects/Plan.md', content: '# Plan\nNew text' }]);
	assert.equal(rest, 'Done.\n\nAlso see above.');
	assert.equal(editTargetPath('Projects/Plan'), 'Projects/Plan.md');
	assert.equal(editTargetPath('/Inbox/Note.md'), 'Inbox/Note.md');
	assert.equal(editTargetPath('../outside.md'), null);
	assert.equal(editTargetPath('.obsidian/app.json'), null);
	assert.equal(editTargetPath('C:/Windows/x.md'), null);
	assert.equal(editTargetPath(''), null);
});

test('line diff and folding', () => {
	const diff = lineDiff('a\nb\nc', 'a\nB\nc\nd');
	assert.deepEqual(diff, [
		{ type: 'same', text: 'a' }, { type: 'remove', text: 'b' }, { type: 'add', text: 'B' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' },
	]);
	const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
	const folded = foldDiff(lineDiff(long, long.replace('line 10', 'changed')), 2);
	assert.deepEqual(folded[0], { type: 'fold', count: 8 });
	assert.ok(folded.some(line => line.type === 'add' && line.text === 'changed'));
	assert.deepEqual(folded[folded.length - 1], { type: 'fold', count: 7 });
});

test('pending changes and new options survive saving and loading', () => {
	const changes = normalizePendingChanges([
		{ id: 'c1', jobId: 'j', taskNumber: 2, taskTitle: 'T', createdAt: '2026-10-18T00:00:00.000Z', kind: 'append', path: 'Daily/2026-10-18.md', content: 'x', heading: 'AI', dailyNote: true },
		{ id: 'c2', kind: 'delete', path: 'x.md', content: '' },
		null,
	]);
	assert.equal(changes.length, 1);
	assert.equal(changes[0].heading, 'AI');
	assert.equal(changes[0].dailyNote, true);
	const job = normalizeJob({ title: 'T', prompt: 'p', output: { tasks: true, taskTag: '#ai', template: ' Templates/R.md ' }, schedule: { kind: 'daily', time: '09:00' } });
	assert.equal(parseStoredData({ version: 6, settings: {}, jobs: [] }).settings.approvalMode, true, 'approval is on by default');
	assert.equal(parseStoredData({ version: 6, settings: { approvalMode: false }, jobs: [] }).settings.approvalMode, false);
	assert.equal(parseStoredData({ version: 6, settings: {}, jobs: [] }).settings.dashboardLocation, 'sidebar', 'the dashboard opens in the sidebar by default');
	assert.equal(parseStoredData({ version: 6, settings: { dashboardLocation: 'modal' }, jobs: [] }).settings.dashboardLocation, 'modal');
	assert.equal(parseStoredData({ version: 6, settings: { dashboardLocation: 'left' }, jobs: [] }).settings.dashboardLocation, 'sidebar');
	assert.deepEqual(job.output, { folder: undefined, filename: undefined, tasks: true, taskTag: 'ai', template: 'Templates/R.md' });
});
