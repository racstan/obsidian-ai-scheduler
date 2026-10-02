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
const normalizePath = (p) => String(p || '').replace(/\\\\/g, '/');
module.exports = {
	Plugin, Modal, PluginSettingTab, Notice, TFile, TFolder, TAbstractFile,
	normalizePath,
	parseYaml: (text) => {
		try { return JSON.parse(text); } catch { return {}; }
	},
	stringifyYaml: (data) => JSON.stringify(data, null, 1),
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
		workspace: { getActiveFile: () => null, on() { return {}; } },
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

	// Test command palette commands: disable, enable, toggle nightly review, and bulk tasks
	assert.ok(app.commands.commands['disable-nightly-review'], 'disable-nightly-review command registered');
	await app.commands.commands['disable-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, false);
	assert.equal(first.jobs.find(j => j.routine === 'daily-review').enabled, false);

	assert.ok(app.commands.commands['enable-nightly-review'], 'enable-nightly-review command registered');
	await app.commands.commands['enable-nightly-review'].callback();
	assert.equal(first.settings.nightlyReviewEnabled, true);
	assert.equal(first.jobs.find(j => j.routine === 'daily-review').enabled, true);

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
	const nightly = app._pluginData.jobs.find(job => job.routine === 'daily-review');
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

	// Test Deletion without resurrection
	await second.deleteJob(recovered);
	assert.ok(!second.jobs.some(j => j.title === 'Smoke task'), 'job removed from memory');
	assert.equal(app.vault.getAbstractFileByPath(recovered.notePath), null, 'note trashed on deletion');
	await second.notesSync.syncAll();
	assert.ok(!second.jobs.some(j => j.title === 'Smoke task'), 'syncAll does not resurrect deleted job');

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
