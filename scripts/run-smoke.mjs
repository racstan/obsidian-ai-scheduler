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
// Enough of moment's formatting for the date patterns the plugin uses.
const moment = (date) => ({
	startOf: () => { const d = new Date(date); d.setHours(0, 0, 0, 0); return moment(d); },
	clone: () => moment(new Date(date)),
	add: (amount) => { const d = new Date(date); d.setDate(d.getDate() + amount); return moment(d); },
	toDate: () => new Date(date),
	valueOf: () => new Date(date).getTime(),
	format: (pattern) => {
		const d = new Date(date);
		const pad = (n) => String(n).padStart(2, '0');
		return String(pattern).replace('YYYY', String(d.getFullYear())).replace('MM', pad(d.getMonth() + 1))
			.replace('DD', pad(d.getDate())).replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes()));
	},
});
module.exports = {
	Plugin, Modal, PluginSettingTab, Notice, TFile, TFolder, TAbstractFile, AbstractInputSuggest,
	FuzzySuggestModal,
	Platform: { isMobile: false, isDesktop: true, isPhone: false },
	normalizePath,
	moment,
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
					tab.lastPrompt = payload && payload.content || '';
					// Simulates Claudian's "Message was not sent": nothing is added.
					if (tab.rejectSends > 0) { tab.rejectSends--; return; }
					// Simulates a provider/model failure, which Claudian writes into the reply.
					if (tab.errorReply) { tab.state.messages.push({ role: 'assistant', content: tab.errorReply }); return; }
					const content = payload && payload.content || '';
					tab.state.messages.push({
						role: 'assistant',
						content: content.includes('planning brain') ? (tab.plannerReply ?? PLANNER_REPLY) : (tab.taskReply ?? GENERIC_REPLY),
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
		_localStorage: {},
		loadLocalStorage(key) { return key in this._localStorage ? this._localStorage[key] : null; },
		saveLocalStorage(key, value) { this._localStorage[key] = value; },
		_savedCount: 0,
		workspace: {
			getActiveFile: () => null,
			on() { return {}; },
			onLayoutReady(cb) { cb(); },
			_opened: [],
			getLeaf() { return { openFile: async (file) => { app.workspace._opened.push(file.path); } }; },
		},
		plugins: { plugins: {} },
		internalPlugins: {
			getPluginById: (id) => id === 'daily-notes' ? { instance: { options: { folder: 'Daily', format: 'YYYY-MM-DD' } } } : null,
		},
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
	assert.equal(first.settings.approvalMode, true, "approval mode is on by default");
	// The checks below predate approval mode; it is tested on its own further down.
	first.settings.approvalMode = false;
	assert.ok(Array.isArray(first.jobs));
	assert.equal(first.jobs.length, 0, 'fresh install starts with no jobs');
	// A fresh install creates and opens the getting-started guide once.
	await new Promise(resolve => setTimeout(resolve, 50));
	const guide = app.vault.getAbstractFileByPath('AI Scheduler - Getting started.md');
	assert.ok(guide && guide._content.includes('needs an AI backend'), 'getting-started guide created on first install');
	assert.deepEqual(app.workspace._opened, ['AI Scheduler - Getting started.md'], 'guide opened once');
	assert.equal(first.settings.gettingStartedShown, true);

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
	await assert.rejects(first.planAndCreate('Every weekday morning, review my notes'), /refused to send the message/);
	claudianTab.rejectSends = 0;
	for (const job of retried.jobs) await first.deleteJob(job);

	// "At 12 pm today" asked after noon: nothing is created, the error offers the next day instead.
	const pastAt = new Date(Date.now() - 90 * 60_000).toISOString();
	claudianTab.plannerReply = '<assistant-scheduler>[{"title":"Tech news","prompt":"Fetch the latest tech news","schedule":{"kind":"once","at":"' + pastAt + '"}}]</assistant-scheduler>';
	const jobsBeforePast = first.jobs.length;
	const pastError = await first.planAndCreate('at 12pm today fetch latest tech news').then(() => null, error => error);
	assert.equal(pastError?.name, 'PastTimePlanError', 'a plan in the past is reported as such');
	assert.equal(first.jobs.length, jobsBeforePast, 'nothing is created for a past time');
	assert.equal(new Date(pastError.nextTimes[0]).getTime(), new Date(pastAt).getTime() + 24 * 3600_000, 'moves to the same time tomorrow');
	const moved = await pastError.reschedule();
	assert.equal(moved.length, 1);
	assert.equal(moved[0].nextRunAt, pastError.nextTimes[0], 'the rescheduled task runs tomorrow');
	await first.deleteJob(moved[0]);

	// "Run again" on a past repeating task makes it a one-time task, at a chosen time or now.
	const ended = await first.addJob({ title: 'Ended daily', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } });
	ended.enabled = false;
	ended.status = 'completed';
	ended.nextRunAt = null;
	const later = new Date(Date.now() + 3 * 3600_000);
	await first.rerunJob(ended, later);
	assert.equal(ended.schedule.kind, 'once', 'a repeating task becomes one-time');
	assert.equal(ended.enabled, true);
	assert.equal(ended.nextRunAt, later.toISOString(), 'runs at the chosen time');
	await assert.rejects(first.rerunJob(ended, new Date(Date.now() - 60_000)), /already passed/);
	const endedRuns = ended.runCount;
	await first.rerunJob(ended, null);
	assert.equal(ended.runCount, endedRuns + 1, 'run now runs it');
	assert.equal(ended.enabled, false, 'after running once it is past again, not repeating');
	assert.equal(ended.schedule.kind, 'once');
	await first.deleteJob(ended);

	// A reply without any schedule shows what the AI said.
	claudianTab.plannerReply = 'Sorry, 12 pm today has already passed. Did you mean tomorrow?';
	await assert.rejects(first.planAndCreate('at 12pm today fetch latest tech news'), /It said: "Sorry, 12 pm today has already passed/);
	delete claudianTab.plannerReply;

	// A model/provider error from Claudian reaches the user with Claudian's own message,
	// for the planner and for scheduled runs (which must fail, not "complete").
	claudianTab.errorReply = '\\n\\n❌ **Error:** Model smoke-model is not available';
	await assert.rejects(first.planAndCreate('Every weekday morning, review my notes'), /Claudian reported an error: Model smoke-model is not available/);
	const errorRuns = cronJob.runCount;
	await first.runJobNow(cronJob);
	assert.equal(cronJob.status, 'failed', 'a Claudian error fails the run');
	assert.match(cronJob.lastError, /Claudian reported an error: Model smoke-model is not available/);
	assert.equal(cronJob.runCount, errorRuns, 'a failed run is not counted as completed');
	claudianTab.errorReply = null;

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
	second.settings.approvalMode = false;
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

	assert.equal(app.workspace._opened.length, 1, 'the guide is not reopened when the plugin reloads');

	// Output modes: add to one note under a heading, with {{variables}} filled in.
	const appender = await second.addJob({
		title: 'Appender', prompt: 'Summarize {{date}}', schedule: { kind: 'daily', time: '09:00' },
		output: { folder: 'Logs', filename: 'Run log {{date}}', mode: 'append', heading: 'Runs' },
	});
	await second.runJobNow(appender);
	await second.runJobNow(appender);
	const today = second.formatDate(new Date(), 'YYYY-MM-DD');
	assert.ok(claudianTab.lastPrompt.includes('Summarize ' + today), 'prompt variables are filled in');
	const logNote = app.vault.getAbstractFileByPath('Logs/Run log ' + today + '.md');
	assert.ok(logNote, 'append mode creates the note named with the date variable');
	assert.ok(logNote._content.startsWith('## Runs'), 'a missing heading is created');
	assert.equal(logNote._content.split(GENERIC_REPLY).length - 1, 2, 'each run is added');
	assert.equal(appender.lastOutputAppended, true);
	assert.equal(appender.history.length, 2, 'both runs are in the history');
	assert.equal(appender.history[1].output, logNote.path);
	// A later "replace" never overwrites a note the task only added to.
	appender.output = { folder: 'Logs', filename: 'Run log ' + today, mode: 'replace' };
	await second.runJobNow(appender);
	assert.ok(logNote._content.includes('## Runs'), 'appended-to note is not replaced');
	assert.equal(appender.lastOutputPath, 'Logs/Run log ' + today + '-2.md');
	// Daily note mode uses the Daily notes folder and date format.
	appender.output = { mode: 'daily', heading: 'AI' };
	await second.runJobNow(appender);
	const dailyNote = app.vault.getAbstractFileByPath('Daily/' + today + '.md');
	assert.ok(dailyNote && dailyNote._content.includes('## AI') && dailyNote._content.includes(GENERIC_REPLY), 'daily note gets the result under the heading');

	// Approval mode: adding to an existing note waits; approving applies it.
	second.settings.approvalMode = true;
	const dailyBefore = dailyNote._content;
	await second.runJobNow(appender);
	assert.equal(dailyNote._content, dailyBefore, 'an existing note is not changed before approval');
	assert.equal(second.pendingChanges.length, 1);
	assert.equal(second.pendingChanges[0].kind, 'append');
	assert.ok(claudianTab.lastPrompt.includes('ai-scheduler-edit'), 'the AI is told to propose edits');
	assert.equal(appender.history[appender.history.length - 1].pending, 1);
	await second.approveChange(second.pendingChanges[0]);
	assert.equal(dailyNote._content.split(GENERIC_REPLY).length - 1, 2, 'approved: the result is added');
	assert.equal(second.pendingChanges.length, 0);
	// An edit the AI proposes is held, and rejecting drops it.
	claudianTab.taskReply = 'Summary.\\n<ai-scheduler-edit path="Journal/today.md">\\nrewritten\\n</ai-scheduler-edit>';
	await second.runJobNow(appender);
	const proposed = second.pendingChanges.find(change => change.kind === 'edit');
	assert.ok(proposed && proposed.path === 'Journal/today.md' && proposed.content === 'rewritten', 'proposed edit is staged');
	assert.equal(app.vault.getAbstractFileByPath('Journal/today.md')._content, 'my own note', 'not applied before approval');
	assert.ok(!app._pluginData.pendingChanges.some(change => change.content.includes('ai-scheduler-edit')), 'the edit block is not part of the saved result');
	for (const change of [...second.pendingChanges]) await second.rejectChange(change);
	assert.equal(app.vault.getAbstractFileByPath('Journal/today.md')._content, 'my own note', 'rejected edit leaves the note alone');
	delete claudianTab.taskReply;
	second.settings.approvalMode = false;

	// Tasks format and a template for new result notes.
	await app.vault.create('Templates/Result.md', '# {{task}} {{date}}\\n\\n{{result}}\\n\\nEnd');
	claudianTab.taskReply = 'Plan:\\n* [ ] Call Sam\\n- [x] Old';
	appender.output = { folder: 'Results', mode: 'new', tasks: true, taskTag: 'ai', template: 'Templates/Result.md' };
	await second.runJobNow(appender);
	const templated = app.vault.getAbstractFileByPath(appender.lastOutputPath);
	assert.ok(templated._content.startsWith('# Appender ' + today), 'template with variables');
	assert.ok(templated._content.includes('- [ ] Call Sam #ai\\n- [x] Old'), 'task lines for the Tasks plugin');
	assert.ok(templated._content.trimEnd().endsWith('End'), 'result placed at {{result}}');
	assert.ok(claudianTab.lastPrompt.includes('Tasks plugin format'), 'the AI is asked for task lines');
	delete claudianTab.taskReply;

	// Dataview queries in the instructions are run before sending.
	app.plugins.plugins.dataview = { api: { queryMarkdown: async query => ({ successful: true, value: 'RESULT OF ' + query }) } };
	appender.prompt = 'Look at {{dataview: LIST FROM #todo}}';
	appender.output = null;
	await second.runJobNow(appender);
	assert.ok(claudianTab.lastPrompt.includes('RESULT OF LIST FROM #todo'), 'Dataview result in the prompt');
	delete app.plugins.plugins.dataview;

	// Google Calendar: without a connection the event variables say so.
	appender.prompt = 'Plan around {{today_events}}';
	assert.ok((await second.previewPrompt(appender)).includes('(Google Calendar is not connected.)'));
	// Connected (fake API): events fill the variables, and a meeting task runs before its event.
	second.saveDeviceSetting('google-tokens', { access: 'a', refresh: 'r', expires: Date.now() + 3600000, email: 'me@example.com' });
	assert.equal(second.google.connected, true);
	assert.equal(second.google.email, 'me@example.com');
	const soon = new Date(Date.now() + 20 * 60000);
	const apiCalls = [];
	const appEvents = new Map();
	second.google.api = async (method, apiPath, query, body) => {
		apiCalls.push(method + ' ' + apiPath);
		if (method === 'GET' && apiPath === '/calendars/primary/events') {
			return { items: [
				{ id: 'm1', summary: 'Weekly standup', start: { dateTime: soon.toISOString() }, end: { dateTime: new Date(soon.getTime() + 900000).toISOString() } },
				{ id: 'm2', summary: 'Lunch', start: { dateTime: soon.toISOString() }, end: { dateTime: new Date(soon.getTime() + 900000).toISOString() } },
			] };
		}
		if (method === 'POST' && apiPath === '/calendars') return { id: 'appcal' };
		if (method === 'GET' && apiPath === '/calendars/appcal/events') return { items: [...appEvents.values()] };
		if (method === 'POST' && apiPath === '/calendars/appcal/events') {
			appEvents.set(body.id, { id: body.id, summary: body.summary, description: body.description, start: body.start });
			return {};
		}
		if (method === 'DELETE' && apiPath.startsWith('/calendars/appcal/events/')) {
			appEvents.delete(apiPath.split('/').pop());
			return {};
		}
		return {};
	};
	assert.ok((await second.previewPrompt(appender)).includes('Weekly standup'), 'today\\'s events in the prompt');
	const prep = await second.addJob({ title: 'Standup prep', prompt: 'Prepare notes for {{event}}', schedule: { kind: 'meeting', minutesBefore: 30, eventMatch: 'standup' } });
	assert.equal(prep.nextRunAt, null);
	assert.equal(await second.google.pollMeetings(() => false, true), true);
	assert.equal(prep.triggerEvent.title, 'Weekly standup');
	assert.ok(new Date(prep.nextRunAt).getTime() <= Date.now() + 1000, 'within 30 minutes of the event: due now');
	await second.tick();
	assert.equal(prep.runCount, 1, 'the meeting task ran');
	assert.ok(claudianTab.lastPrompt.includes('Title: Weekly standup'), 'the event is in the prompt');
	assert.equal(prep.nextRunAt, null, 'waits for the next event');
	await second.google.pollMeetings(() => false, true);
	assert.equal(prep.nextRunAt, null, 'the same event does not run it again');
	assert.equal(prep.triggerEvent, undefined);
	await second.deleteJob(prep);
	// Show runs in Google: the calendar is made and holds the upcoming runs.
	second.settings.googleShowRuns = true;
	const digest = await second.addJob({ title: 'Digest', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } });
	await second.google.syncRuns(true);
	assert.ok(apiCalls.includes('POST /calendars'), 'calendar created');
	assert.ok([...appEvents.values()].some(entry => entry.summary === 'AI: Digest'), 'runs added');
	await second.deleteJob(digest);
	await second.google.syncRuns(true);
	assert.ok(![...appEvents.values()].some(entry => entry.summary === 'AI: Digest'), 'runs of a deleted task removed');
	second.settings.googleShowRuns = false;
	second.saveDeviceSetting('google-tokens', null);
	second.saveDeviceSetting('google-app-calendar', null);
	assert.equal(second.google.connected, false);

	// A device set not to run tasks leaves due tasks alone; "Run now" still works there.
	second.setRunsTasksHere(false);
	assert.equal(second.runsTasksHere, false);
	const elsewhere = await second.addJob({ title: 'Runs elsewhere', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } });
	elsewhere.nextRunAt = new Date(Date.now() - 1000).toISOString();
	await second.tick();
	assert.equal(elsewhere.runCount, 0, 'not started on this device');
	await second.runJobNow(elsewhere);
	assert.equal(elsewhere.runCount, 1, 'Run now works on any device');
	second.setRunsTasksHere(true);
	await second.deleteJob(elsewhere);

	// A failed run is retried after the delay, and the count resets on success.
	const flaky = await second.addJob({ title: 'Flaky', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, retries: 1, retryDelayMinutes: 2 });
	claudianTab.errorReply = '\\n\\n❌ **Error:** temporary';
	await second.runJobNow(flaky);
	assert.equal(flaky.status, 'scheduled', 'a failed run waits for its retry');
	assert.equal(flaky.retryCount, 1);
	const retryIn = new Date(flaky.nextRunAt).getTime() - Date.now();
	assert.ok(retryIn > 60_000 && retryIn <= 120_000, 'the retry is scheduled after the delay');
	claudianTab.errorReply = null;
	flaky.nextRunAt = iso(1000);
	await second.tick();
	assert.equal(flaky.status, 'completed');
	assert.equal(flaky.retryCount, 0);
	assert.deepEqual(flaky.history.map(r => r.status + ':' + (r.retry || 0)), ['failed:0', 'completed:1']);

	// "Only run when something changed" skips a run while the attached note is unchanged.
	await app.vault.create('Notes/watched.md', 'v1');
	const watched = app.vault.getAbstractFileByPath('Notes/watched.md');
	watched.stat = { mtime: Date.now() - 60_000 };
	const watcher = await second.addJob({ title: 'Watcher', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, contextPaths: ['Notes/watched.md'], onlyIfChanged: true });
	await second.runJobNow(watcher);
	assert.equal(watcher.runCount, 1, 'the first run always runs');
	await second.runJobNow(watcher);
	assert.equal(watcher.runCount, 1, 'unchanged note: the run is skipped');
	assert.equal(watcher.history[watcher.history.length - 1].status, 'skipped');
	assert.ok(watcher.nextRunAt && new Date(watcher.nextRunAt).getTime() > Date.now(), 'a skipped run moves to the next slot');
	watched.stat = { mtime: Date.now() + 1000 };
	await second.runJobNow(watcher);
	assert.equal(watcher.runCount, 2, 'changed note: the task runs');

	// Run history and run options are saved (reload normalization is unit-tested).
	await second.saveState();
	const savedFlaky = app._pluginData.jobs.find(j => j.id === flaky.id);
	assert.equal(savedFlaky.history.length, 2, 'history is saved');
	assert.equal(savedFlaky.retries, 1);
	assert.equal(savedFlaky.retryDelayMinutes, 2);
	assert.equal(app._pluginData.jobs.find(j => j.id === watcher.id).onlyIfChanged, true);

	// A task set to run after another starts when that one finishes, with its result.
	const collect = await second.addJob({ title: 'Collect', prompt: 'collect', schedule: { kind: 'daily', time: '09:00' } });
	const summarize = await second.addJob({ title: 'Summarize', prompt: 'Summarize: {{previous_result}}', schedule: { kind: 'after', afterTask: collect.id } });
	assert.equal(summarize.nextRunAt, null, 'a chained task waits');
	await second.runJobNow(collect);
	assert.ok(summarize.nextRunAt, 'finishing the first task queues the next');
	summarize.nextRunAt = iso(1000);
	await second.tick();
	assert.equal(summarize.runCount, 1, 'the chained task ran');
	assert.ok(claudianTab.lastPrompt.includes('Summarize: ' + GENERIC_REPLY), 'the previous result is passed on');
	await assert.rejects(second.updateJob(collect, { schedule: { kind: 'after', afterTask: summarize.id } }), /loop/);
	assert.equal(collect.schedule.kind, 'daily', 'a refused edit leaves the task unchanged');
	await assert.rejects(second.addJob({ title: 'Orphan', prompt: 'p', schedule: { kind: 'after', afterTask: 'missing' } }), /Choose the task/);

	// While paused nothing starts on its own, but "Run now" does.
	await second.pauseAll(null);
	const waiting = await second.addJob({ title: 'Waiting', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, nextRunAt: iso(5000) });
	await second.tick();
	assert.equal(waiting.runCount, 0, 'paused: the due task does not start');
	await second.runJobNow(waiting);
	assert.equal(waiting.runCount, 1, 'Run now works while paused');
	waiting.nextRunAt = iso(5000);
	await second.pauseAll(new Date(Date.now() - 1000));
	await second.tick();
	assert.equal(second.settings.paused, false, 'an expired pause ends by itself');
	assert.equal(waiting.runCount, 1, 'a run missed while paused follows the catch-up setting (off: skipped)');
	assert.ok(new Date(waiting.nextRunAt).getTime() > Date.now(), 'the skipped task moves to its next slot');

	// During quiet hours a due task waits, and runs once they end.
	const clockNow = new Date();
	const pad2 = (n) => String(n).padStart(2, '0');
	second.settings.quietHoursEnabled = true;
	second.settings.quietStart = pad2(clockNow.getHours()) + ':00';
	second.settings.quietEnd = pad2((clockNow.getHours() + 2) % 24) + ':00';
	waiting.nextRunAt = iso(5000);
	await second.tick();
	assert.equal(waiting.runCount, 1, 'quiet hours: the due task waits');
	second.settings.quietHoursEnabled = false;
	await second.tick();
	assert.equal(waiting.runCount, 2, 'after the quiet hours the task runs');

	// Tasks export to a JSON file and import back, paused.
	const exportPath = await second.exportTasksFile();
	const exportFile = app.vault.getAbstractFileByPath(exportPath);
	assert.ok(exportPath.endsWith('.json') && exportFile._content.includes('ai-scheduler-tasks'), 'export file written');
	const countBefore = second.jobs.length;
	const importedCount = await second.importTasksText(exportFile._content);
	assert.ok(importedCount > 0);
	assert.equal(second.jobs.length, countBefore + importedCount);
	assert.ok(second.jobs.slice(-importedCount).every(j => !j.enabled), 'imported tasks are paused');

	// A failed AI request is saved as a draft in data.json and forgotten once it goes through.
	await second.saveDraft('planner', { text: 'Plan my week', contextPaths: [], resultFolder: '', error: 'Backend not ready' });
	assert.equal(app._pluginData.settings.drafts.planner.error, 'Backend not ready', 'draft persisted');
	const savesBefore = app._savedCount;
	await second.saveDraft('planner', { text: 'Plan my week', contextPaths: [], resultFolder: '', error: 'Backend not ready' });
	assert.equal(app._savedCount, savesBefore, 'an unchanged draft is not saved again');
	await second.saveDraft('planner', null);
	assert.equal(second.getDraft('planner'), null);
	assert.equal(app._pluginData.settings.drafts.planner, undefined, 'draft cleared');

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
