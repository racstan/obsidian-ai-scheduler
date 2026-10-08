/*
 * Smoke test: loads the built main.js with a stubbed obsidian module and a
 * fake vault app, runs onload through a full job lifecycle, then reloads to
 * verify persistence and interrupted-run recovery.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const OBSIDIAN_STUB = `
class Component {
	constructor() { this._events = []; this._intervals = []; }
	registerEvent(ref) { this._events.push(ref); }
	registerInterval(id) { this._intervals.push(id); return id; }
	registerDomEvent() {}
	register() {}
	load() {}
	onload() {}
	onunload() {}
	unload() {}
}
class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this.data = app._pluginData;
	}
	async loadData() { return this.data; }
	async saveData(data) { this.app._pluginData = data; this.app._savedCount = (this.app._savedCount || 0) + 1; }
	addRibbonIcon() {}
	addCommand(cmd) { this.app.commands.commands[cmd.id] = cmd; }
	addSettingTab() {}
	addStatusBarItem() { return { empty() {}, hide() {}, show() {}, addClass() {}, remove() {}, setAttribute() {}, createSpan() { return { setText() {}, addClass() {} }; } }; }
}
class Modal {
	constructor(app) { this.app = app; this.contentEl = { empty() {}, createEl() { return { style: {}, createEl() { return { style: {} }; } }; } }; this.modalEl = { style: {} }; }
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}
class PluginSettingTab {
	constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {}, createEl() { return { style: {}, createEl() { return { style: {} }; } }; } }; }
	display() {}
}
class Notice { constructor(text) { Notice.last = String(text); } }
class TFile { constructor() { this.stat = { mtime: 0 }; } }
class TFolder { constructor() { this.children = []; } }
class TAbstractFile {}
class AbstractInputSuggest {
	constructor(app, inputEl) { this.app = app; this.inputEl = inputEl; }
	setValue(value) { this.inputEl.value = value; }
	getValue() { return this.inputEl.value; }
	close() {}
}
class FuzzySuggestModal extends Modal {
	setPlaceholder() {}
	getItems() { return []; }
	getItemText() { return ''; }
	onChooseItem() {}
}
const normalizePath = (p) => String(p || '').replace(/\\\\/g, '/');
module.exports = {
	Plugin, Modal, PluginSettingTab, Notice, TFile, TFolder, TAbstractFile, AbstractInputSuggest,
	FuzzySuggestModal,
	normalizePath,
	parseYaml: (text) => {
		try { return JSON.parse(text); } catch { return {}; }
	},
	stringifyYaml: (data) => JSON.stringify(data, null, 1),
	getFrontMatterInfo: (content) => {
		const nl = String.fromCharCode(10);
		const lines = String(content).split(nl);
		const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
		return end < 0 ? { exists: false, frontmatter: '' } : { exists: true, frontmatter: lines.slice(1, end).join(nl) };
	},
	requestUrl: () => { throw new Error('unused'); },
	Setting: class {},
};
`;

const RUNNER = `
const assert = require('node:assert');
// Obsidian plugins run in the renderer; provide the minimal window surface
// the plugin touches (setInterval/clearTimeout for the tick loop).
globalThis.window = globalThis;
window.confirm = () => true;
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
window.setInterval = setInterval;
window.clearInterval = clearInterval;
const obsidian = require('obsidian');
const mod = require('./main.cjs');
const PluginClass = mod.default || mod;
assert.equal(typeof PluginClass, 'function', 'bundle must expose an Obsidian-compatible plugin constructor');

const GENERIC_REPLY = 'SMOKE REPLY';
const PLANNER_REPLY = '<assistant-scheduler>[{"title":"Morning review","prompt":"Review the notes","schedule":{"kind":"cron","expression":"0 9 * * 1-5"}},{"title":"One-off thing","prompt":"Do it","schedule":{"kind":"once","at":"2099-01-01T09:00:00.000Z"}}]</assistant-scheduler>';

function iso(msAgo) { return new Date(Date.now() - msAgo).toISOString(); }

function makeClaudian() {
	const tab = {
		id: 'tab-1',
		conversationId: null,
		state: { messages: [], isStreaming: false },
		controllers: {
			inputController: {
				sendMessage: async (payload) => {
					// Simulates Claudian's "Message was not sent": nothing is added.
					if (tab.rejectSends > 0) { tab.rejectSends--; return; }
					const content = payload && payload.content || '';
					tab.state.messages.push({
						role: 'assistant',
						content: content.includes('planning brain') ? PLANNER_REPLY : GENERIC_REPLY,
					});
				},
			},
		},
	};
	const manager = {
		getAllTabs: () => [tab],
		getTabBarItems: () => [{ id: 'tab-1', isWorking: false }],
		isTabWorking: () => false,
		getActiveTabId: () => 'tab-1',
		getActiveTab: () => tab,
	};
	const view = { getTabManager: () => manager, getActiveTab: () => tab };
	return {
		_tab: tab,
		getAllViews: () => [view],
		activateView: async () => {},
		createConversation: async () => ({ id: 'conv-1' }),
		renameConversation: async () => {},
		getConversationSync: () => null,
		settings: { savedProviderModel: { claude: 'smoke-model' }, settingsProvider: 'claude' },
	};
}

function fakeApp() {
	const files = new Map();
	const eventListeners = { modify: [], create: [], delete: [], rename: [] };
	const app = {
		_pluginData: null,
		_savedCount: 0,
		workspace: { getActiveFile: () => null, on() { return {}; }, onLayoutReady(cb) { cb(); } },
		plugins: { plugins: {} },
		commands: { commands: {}, executeCommand() {} },
		fileManager: {
			trashFile: async (file) => {
				files.delete(file.path);
				const folderPath = file.path.split('/').slice(0, -1).join('/');
				const folder = files.get(folderPath);
				if (folder && folder.children) {
					folder.children = folder.children.filter(c => c.path !== file.path);
				}
				for (const listener of eventListeners.delete) listener(file);
			},
			renameFile: async (file, newPath) => {
				const oldPath = file.path;
				files.delete(oldPath);
				const oldFolderPath = oldPath.split('/').slice(0, -1).join('/');
				const oldFolder = files.get(oldFolderPath);
				if (oldFolder && oldFolder.children) {
					oldFolder.children = oldFolder.children.filter(c => c.path !== oldPath);
				}
				file.path = newPath;
				files.set(newPath, file);
				const newFolderPath = newPath.split('/').slice(0, -1).join('/');
				const newFolder = files.get(newFolderPath);
				if (newFolder && newFolder.children) {
					newFolder.children.push(file);
				}
				for (const listener of eventListeners.rename) listener(file, oldPath);
			},
		},
		vault: {
			on(event, cb) {
				if (eventListeners[event]) eventListeners[event].push(cb);
				return {};
			},
			getMarkdownFiles: () => [...files.values()].filter(f => f.path && f.path.endsWith('.md')),
			getAllLoadedFiles: () => [...files.values()],
			getAbstractFileByPath: (p) => files.get(p) || null,
			createFolder: async (p) => {
				const folder = Object.assign(new obsidian.TFolder(), { path: p, children: [] });
				files.set(p, folder);
			},
			create: async (p, content) => {
				const f = Object.assign(new obsidian.TFile(), { path: p, _content: content, extension: 'md' });
				files.set(p, f);
				const folderPath = p.split('/').slice(0, -1).join('/');
				const folder = files.get(folderPath);
				if (folder && folder.children) folder.children.push(f);
				for (const listener of eventListeners.create) listener(f);
				return f;
			},
			modify: async (file, content) => {
				file._content = content;
				for (const listener of eventListeners.modify) listener(file);
			},
			read: async (file) => file._content || '',
			process: async (file, fn) => {
				file._content = fn(file._content || '');
				for (const listener of eventListeners.modify) listener(file);
				return file._content;
			},
			configDir: '.obsidian',
			adapter: { getBasePath: () => '/fake/vault' },
		},
		metadataCache: {
			getFileCache: (file) => {
				const content = file._content || '';
				const match = /^---[\\r\\n]+([\\s\\S]*?)[\\r\\n]+---/m.exec(content);
				if (!match) return null;
				try {
					return { frontmatter: JSON.parse(match[1]) };
				} catch {
					return null;
				}
			},
		},
	};
	return app;
}

async function main() {
	const app = fakeApp();
	app.plugins.plugins.realclaudian = makeClaudian();

	const first = new PluginClass(app, { id: 'ai-scheduler', version: '2.1.1' });
	await first.onload();
	assert.ok(Array.isArray(first.jobs));
	assert.equal(first.jobs.length, 0, 'fresh install starts with no jobs');

	// Wire the plugin to the stubbed Claudian model enumeration.
	const modelValue = first.getModelOptions()[0].value;
	first.settings.executionModel = modelValue;
	first.settings.planningModel = modelValue;

	// Enable the nightly review routine so its managed job exists.
	first.settings.nightlyReviewEnabled = true;
	await first.ensureNightlyReviewJob();
	assert.equal(first.jobs.length, 1, 'nightly review job created');

	const created = await first.addJob({
		title: 'Smoke task',
		prompt: 'Say hi',
		schedule: { kind: 'daily', time: '00:00' },
		nextRunAt: iso(60_000),
	});
	const cronJob = await first.addJob({ title: 'Cron task', prompt: 'p', schedule: { kind: 'cron', expression: '*/15 * * * *' } });
	assert.equal(cronJob.schedule.kind, 'cron');
	assert.ok(cronJob.nextRunAt, 'cron job resolves a next run');

	let rejected = false;
	try {
		await first.addJob({ title: 'Bad', prompt: 'p', schedule: { kind: 'cron', expression: '90 * * * *' } });
	} catch (error) {
		rejected = String(error).includes('invalid');
	}
	assert.ok(rejected, 'invalid cron expression must be rejected at creation');

	await first.tick();
	assert.equal(created.status, 'completed', 'due job ran through the Claudian path');
	assert.equal(created.lastReply, GENERIC_REPLY);
	assert.equal(created.runCount, 1);
	assert.ok(created.nextRunAt && new Date(created.nextRunAt).getTime() > Date.now(), 'recurring job rescheduled after run');

	// The AI planner creates jobs end-to-end, including a cron schedule.
	const plan = await first.planAndCreate('Every weekday morning, review my notes');
	assert.equal(plan.jobs.length, 2);
	assert.equal(plan.jobs[0].schedule.kind, 'cron');
	assert.equal(plan.jobs[0].schedule.expression, '0 9 * * 1-5');
	assert.ok(plan.jobs[1].nextRunAt, 'once plan resolves a next run');

	// A send Claudian refuses ("Message was not sent") is retried; if it keeps
	// refusing, the planner reports that instead of "no valid schedule".
	const claudianTab = app.plugins.plugins.realclaudian._tab;
	claudianTab.rejectSends = 1;
	const retried = await first.planAndCreate('Every weekday morning, review my notes');
	assert.equal(retried.jobs.length, 2, 'planning succeeds after a refused send');
	claudianTab.rejectSends = 3;
	await assert.rejects(first.planAndCreate('Every weekday morning, review my notes'), /did not accept the message/);
	claudianTab.rejectSends = 0;
	for (const job of retried.jobs) await first.deleteJob(job);

	// Test command palette commands: disable, enable, toggle nightly review, and bulk tasks
	assert.ok(app.commands.commands['disable-nightly-review'], 'disable-nightly-review command registered');
	await app.commands.commands['disable-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, false);
	assert.equal(first.jobs.find(j => j.routine === 'periodic-review').enabled, false);

	assert.ok(app.commands.commands['enable-nightly-review'], 'enable-nightly-review command registered');
	await app.commands.commands['enable-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, true);
	assert.equal(first.jobs.find(j => j.routine === 'periodic-review').enabled, true);

	assert.ok(app.commands.commands['toggle-nightly-review'], 'toggle-nightly-review command registered');
	await app.commands.commands['toggle-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, false);
	await app.commands.commands['toggle-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, true);

	assert.ok(app.commands.commands['disable-all-jobs'], 'disable-all-jobs command registered');
	await app.commands.commands['disable-all-jobs'].callback();
	assert.equal(created.enabled, false);

	assert.ok(app.commands.commands['enable-all-jobs'], 'enable-all-jobs command registered');
	await app.commands.commands['enable-all-jobs'].callback();
	assert.equal(created.enabled, true);

	assert.ok(app.commands.commands['sync-schedule-notes'], 'sync-schedule-notes command registered');
	await app.commands.commands['sync-schedule-notes'].callback();

	await first.disableAllJobs();
	assert.equal(created.enabled, false);
	await first.enableJob(created);
	assert.equal(created.enabled, true);
	await first.tick();

	assert.ok(app._pluginData, 'state persisted to data.json');
	assert.equal(app._pluginData.jobs.length, 5, 'nightly + created + cron + 2 planned jobs persisted');
	const nightly = app._pluginData.jobs.find(job => job.routine === 'periodic-review');
	assert.ok(nightly && nightly.schedule.kind === 'daily', 'nightly job persisted with a daily schedule');

	// Simulate a crash mid-run, then reload: recovery must reset the status.
	app._pluginData.jobs.find(job => job.title === 'Smoke task').status = 'running';
	const second = new PluginClass(app, { id: 'ai-scheduler', version: '2.1.1' });
	await second.onload();
	const recovered = second.jobs.find(job => job.title === 'Smoke task');
	assert.equal(recovered.status, 'scheduled', 'interrupted run recovered on load');

	// Test Two-Way Synced Schedule Notes
	second.settings.scheduleNotesEnabled = true;
	const writtenCount = await second.notesSync.syncAll();
	assert.ok(writtenCount > 0, 'schedule notes sync writes notes to folder');
	assert.ok(recovered.notePath, 'job has notePath populated');
	const noteFile = app.vault.getAbstractFileByPath(recovered.notePath);
	assert.ok(noteFile, 'note file exists in vault');
	const noteLines = noteFile._content.split(/[\\r\\n]+/);
	assert.equal(noteLines[0], '---', 'first line of note is frontmatter fence');
	assert.ok(noteLines.slice(1).includes('---'), 'closing frontmatter fence exists on its own line');

	// A note the user moves out of the schedules folder is followed, not recreated.
	const oldNotePath = recovered.notePath;
	await app.fileManager.renameFile(noteFile, 'Elsewhere/moved-task.md');
	await second.notesSync.syncAll();
	assert.equal(recovered.notePath, 'Elsewhere/moved-task.md', 'note path follows the move');
	assert.equal(app.vault.getAbstractFileByPath(oldNotePath), null, 'no duplicate recreated in the schedules folder');

	// Test Deletion without resurrection
	await second.deleteJob(recovered);
	assert.ok(!second.jobs.some(j => j.title === 'Smoke task'), 'job removed from memory');
	assert.equal(app.vault.getAbstractFileByPath(recovered.notePath), null, 'note trashed on deletion');
	await second.notesSync.syncAll();
	assert.ok(!second.jobs.some(j => j.title === 'Smoke task'), 'syncAll does not resurrect deleted job');

	// Output writes stay out of hidden/config folders and never clobber user notes.
	for (const unsafe of ['.obsidian/plugins/evil', '../outside', 'Notes/.hidden']) {
		await assert.rejects(second.writeOutput(unsafe, 'main.js', 'x'), /unsafe folder/, 'rejects ' + unsafe);
	}
	await app.vault.createFolder('Journal');
	await app.vault.create('Journal/today.md', 'my own note');
	const sidePath = await second.writeOutput('Journal', 'today.md', 'AI output');
	assert.equal(sidePath, 'Journal/today-2.md', 'existing user note gets a numbered sibling');
	assert.equal(app.vault.getAbstractFileByPath('Journal/today.md')._content, 'my own note', 'user note untouched');
	assert.equal(await second.writeOutput('Journal', 'report.txt', 'x'), 'Journal/report.txt.md', 'output forced to Markdown');

	// AI-proposed follow-ups are created disabled and cannot pick an output path.
	const parent = second.jobs.find(j => j.title === 'Cron task');
	const before = second.jobs.length;
	await second.processFollowUps('<assistant-scheduler>[{"title":"Injected","prompt":"p","schedule":{"kind":"cron","expression":"* * * * *"},"output":{"folder":"Journal","filename":"today.md"}}]</assistant-scheduler>', parent);
	assert.equal(second.jobs.length, before + 1, 'follow-up created');
	const followUp = second.jobs[second.jobs.length - 1];
	assert.equal(followUp.enabled, false, 'follow-up starts disabled');
	assert.equal(followUp.status, 'disabled');
	assert.equal(followUp.output, null, 'follow-up output location dropped');
	assert.equal(followUp.source, 'self-talk');

	// Recurring schedule fields survive a save/reload round trip.
	const monthly = await second.addJob({ title: 'Monthly', prompt: 'p', schedule: { kind: 'monthly', time: '09:00', dayOfMonth: 15, everyMonths: 2, startAt: '2026-01-15' } });
	await second.saveState();
	const third = new PluginClass(app, { id: 'ai-scheduler', version: '2.1.1' });
	await third.onload();
	const reloaded = third.jobs.find(j => j.id === monthly.id);
	assert.deepEqual(reloaded.schedule, monthly.schedule, 'monthly schedule survives reload');
	assert.equal(reloaded.schedule.dayOfMonth, 15);

	// A job edited before it is registered (calendar "New task") is created on save.
	const draft = Object.assign(JSON.parse(JSON.stringify(monthly)), { id: 'draft-job', title: 'Draft', taskNumber: 0 });
	await second.updateJob(draft, { title: 'From calendar', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } });
	assert.ok(second.jobs.includes(draft), 'new job registered on save');
	assert.ok(draft.taskNumber > 0, 'new job gets a task number');

	// "Run now" runs a recurring job immediately, even when its next slot is in the future.
	const recurring = second.jobs.find(j => j.title === 'Cron task');
	const runsBefore = recurring.runCount;
	recurring.nextRunAt = iso(3_600_000);
	await second.runJobNow(recurring);
	assert.equal(recurring.runCount, runsBefore + 1, 'run now executes a recurring job');

	// The task log appends one numbered row per run, and lists only that run's output.
	second.settings.taskLoggingEnabled = true;
	await second.runJobNow(recurring);
	await second.runJobNow(recurring);
	const logFile = [...app.vault.getMarkdownFiles()].find(f => f.path.endsWith('AI SCHEDULER LOGS.md'));
	assert.ok(logFile, 'task log created');
	const rows = logFile._content.split(String.fromCharCode(10)).filter(line => /^[|] [0-9]+ [|]/.test(line));
	assert.equal(rows.length, 2, 'one log row per run');
	assert.ok(rows[1].startsWith('| 2 |'), 'rows are numbered');
	second.settings.taskLoggingEnabled = false;

	// The calendar export writes an .ics file and refuses unsafe paths.
	const icsPath = await second.exportIcs();
	assert.equal(icsPath, 'AI Scheduler/AI Scheduler.ics');
	assert.ok(app.vault.getAbstractFileByPath(icsPath)._content.includes('BEGIN:VEVENT'), 'calendar file lists runs');
	second.settings.icsExportPath = '.obsidian/evil.ics';
	await assert.rejects(second.exportIcs(), /not a valid calendar file path/);
	second.settings.icsExportPath = 'AI Scheduler/AI Scheduler.ics';

	// Re-ensuring the periodic review with unchanged settings keeps its next run.
	const review = second.jobs.find(j => j.routine === 'periodic-review');
	const overdue = iso(-60_000);
	review.nextRunAt = overdue;
	await second.ensurePeriodicReviewJob();
	assert.equal(review.nextRunAt, overdue, 'unchanged review cadence keeps an overdue run');
	second.settings.reviewTime = '06:30';
	await second.ensurePeriodicReviewJob();
	assert.notEqual(review.nextRunAt, overdue, 'changed review cadence reschedules');

	await second.deleteAllJobs();
	assert.equal(second.jobs.length, 1, 'nightly review job survives delete-all');
	console.log('SMOKE OK');
	// The tick interval registered during onload keeps the event loop alive.
	process.exit(0);
}

main().catch(error => { console.error('SMOKE FAILED:', error); process.exit(1); });
`;

mkdirSync(path.join('.tmp-smoke', 'node_modules', 'obsidian'), { recursive: true });
writeFileSync(path.join('.tmp-smoke', 'node_modules', 'obsidian', 'index.cjs'), OBSIDIAN_STUB);
writeFileSync(path.join('.tmp-smoke', 'node_modules', 'obsidian', 'package.json'), JSON.stringify({ name: 'obsidian', main: 'index.cjs' }));

await build({
	entryPoints: ['main.js'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'es2022',
	logLevel: 'warning',
	outfile: '.tmp-smoke/main.cjs',
	external: ['obsidian'],
});

writeFileSync('.tmp-smoke/run.cjs', RUNNER);
const result = spawnSync(process.execPath, ['.tmp-smoke/run.cjs'], { stdio: 'inherit' });
rmSync('.tmp-smoke', { recursive: true, force: true });
process.exit(result.status ?? 1);
