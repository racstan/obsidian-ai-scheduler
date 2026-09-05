/*
 * Opt-in schedule notes: mirror every job definition into a note inside a
 * vault folder. The note's YAML frontmatter carries the definition (schedule,
 * prompt, enabled, output, context) and is two-way synced; the body holds a
 * human-readable schedule table in cron form between stable markers.
 *
 * data.json keeps mirroring everything, so turning notes off is lossless and
 * the plugin works exactly as before when notes are disabled.
 */
import { TAbstractFile, TFile, normalizePath, stringifyYaml } from 'obsidian';
import { Job, SCHEDULE_KINDS, TaskSchedule } from './types';
import { cronFormFor, describeSchedule, getScheduleNextRun, previewSchedule } from './schedule';
import { normalizeJob } from './settings';

export const TABLE_START = '<!-- ai-scheduler:table:start -->';
export const TABLE_END = '<!-- ai-scheduler:table:end -->';

interface NoteDefinition {
	id?: string;
	taskNumber?: number;
	title?: string;
	prompt?: string;
	enabled?: boolean;
	notify?: boolean;
	schedule?: Record<string, unknown>;
	output?: { folder?: string; filename?: string } | null;
	contextPaths?: string[];
	routine?: string | null;
	cooldownMinutes?: number;
}

function slugify(title: string): string {
	const slug = String(title || 'task')
		.toLowerCase()
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s/g, '-');
	return slug.slice(0, 80) || 'task';
}

export class ScheduleNotesSync {
	private plugin: import('./main').AISchedulerPlugin;
	private lastWritten = new Map<string, string>();
	private syncing = false;
	private debounceTimer: number | null = null;

	constructor(plugin: import('./main').AISchedulerPlugin) {
		this.plugin = plugin;
	}

	get folder(): string {
		return normalizePath(this.plugin.settings.scheduleFolder || 'AI Schedules');
	}

	static isInside(folder: string, path: string): boolean {
		return path === folder || path.startsWith(`${folder}/`);
	}

	notePathFor(job: Job): string {
		if (job.notePath && ScheduleNotesSync.isInside(this.folder, job.notePath)) {
			return job.notePath;
		}
		const claimed = new Set(this.plugin.jobs.map(other => other.id !== job.id ? other.notePath : null).filter(Boolean) as string[]);
		const base = `${String(job.taskNumber || '').padStart(2, '0')}-${slugify(job.title)}`;
		let candidate = normalizePath(`${this.folder}/${base}.md`);
		let suffix = 2;
		while (claimed.has(candidate)) {
			candidate = normalizePath(`${this.folder}/${base}-${suffix}.md`);
			suffix += 1;
		}
		return candidate;
	}

	definitionFor(job: Job): NoteDefinition {
		const schedule: Record<string, unknown> = { kind: job.schedule.kind };
		if (job.schedule.at) schedule.at = job.schedule.at;
		if (job.schedule.time) schedule.time = job.schedule.time;
		if (job.schedule.days) schedule.days = job.schedule.days;
		if (job.schedule.rules) schedule.rules = job.schedule.rules;
		if (job.schedule.event) schedule.event = job.schedule.event;
		if (job.schedule.intervalMinutes) schedule.intervalMinutes = job.schedule.intervalMinutes;
		if (job.schedule.maxIterations) schedule.maxIterations = job.schedule.maxIterations;
		if (job.schedule.expression) schedule.expression = job.schedule.expression;
		const definition: NoteDefinition = {
			id: job.id,
			taskNumber: job.taskNumber,
			title: job.title,
			prompt: job.prompt,
			enabled: job.enabled,
			notify: job.notify,
			schedule,
			output: job.output || null,
			contextPaths: job.contextPaths || [],
			routine: job.routine,
		};
		if (job.cooldownMinutes !== undefined) definition.cooldownMinutes = job.cooldownMinutes;
		return definition;
	}

	private tableSection(job: Job): string {
		const cronForm = cronFormFor(job.schedule);
		const runs = previewSchedule(job.schedule, 3);
		const lines = [
			TABLE_START,
			'## Schedule',
			'',
			'| | |',
			'| --- | --- |',
			`| Kind | \`${job.schedule.kind}\` |`,
			`| Cron form | ${cronForm ? `\`${cronForm}\`` : '—'} |`,
			`| Meaning | ${describeSchedule(job)} |`,
			'',
			'**Next runs**',
			'',
			...(runs.length ? runs.map((run, index) => `${index + 1}. ${run}`) : ['None scheduled']),
			TABLE_END,
		];
		return lines.join('\n');
	}

	renderNote(job: Job): string {
		const frontmatter = stringifyYaml({ 'ai-scheduler': this.definitionFor(job) });
		const body = [
			`# #${job.taskNumber} · ${job.title}`,
			'',
			job.prompt,
			'',
			this.tableSection(job),
			'',
			'Edit the frontmatter above (or use the AI Scheduler dashboard) to change this task; the schedule table updates automatically.',
			'',
		];
		return `---\n${frontmatter}---\n${body.join('\n')}`;
	}

	private async writeFile(path: string, content: string): Promise<void> {
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const current = await this.plugin.app.vault.read(existing);
			if (current === content) {
				this.lastWritten.set(path, content);
				return;
			}
			await this.plugin.app.vault.modify(existing, content);
		} else {
			await this.plugin.app.vault.create(path, content);
		}
		this.lastWritten.set(path, content);
	}

	/** Creates/updates the note for one job. */
	async writeNoteFor(job: Job): Promise<void> {
		if (!this.plugin.settings.scheduleNotesEnabled) return;
		await this.plugin.ensureFolder(this.folder);
		const path = this.notePathFor(job);
		job.notePath = path;
		await this.writeFile(path, this.renderNote(job));
	}

	private async importNote(file: TFile): Promise<boolean> {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const definition = cache?.frontmatter?.['ai-scheduler'] as NoteDefinition | undefined;
		if (!definition || typeof definition !== 'object') return false;
		const scheduleRaw = definition.schedule;
		if (!scheduleRaw || !(SCHEDULE_KINDS as string[]).includes(String(scheduleRaw.kind))) return false;
		if (!String(definition.prompt || '').trim()) return false;
		const schedule = scheduleRaw as unknown as TaskSchedule;
		const existing = this.plugin.jobs.find(job => job.id === definition.id);
		if (existing) {
			this.applyDefinition(existing, definition, file.path);
			return true;
		}
		const job = normalizeJob({
			title: String(definition.title || file.basename),
			prompt: String(definition.prompt),
			enabled: definition.enabled !== false,
			notify: definition.notify !== false,
			schedule,
			contextPaths: Array.isArray(definition.contextPaths) ? definition.contextPaths : [],
			output: definition.output || null,
			routine: definition.routine || null,
			cooldownMinutes: definition.cooldownMinutes,
			notePath: file.path,
		});
		if (job.schedule.kind !== 'event' && !job.nextRunAt) return false;
		this.plugin.jobs.push(job);
		this.plugin.assignTaskNumbers();
		return true;
	}

	/** Applies a note-edited definition to a job without forcing it enabled. */
	private applyDefinition(job: Job, definition: NoteDefinition, notePath: string): void {
		if (definition.title) job.title = String(definition.title);
		if (typeof definition.prompt === 'string') job.prompt = definition.prompt;
		if (typeof definition.enabled === 'boolean') job.enabled = definition.enabled;
		if (typeof definition.notify === 'boolean') job.notify = definition.notify;
		if (Array.isArray(definition.contextPaths)) job.contextPaths = definition.contextPaths.map(String);
		if (definition.output === null || typeof definition.output === 'object') job.output = definition.output || null;
		if (definition.schedule && (SCHEDULE_KINDS as string[]).includes(String(definition.schedule.kind))) {
			const normalized = normalizeJob({ id: job.id, schedule: definition.schedule }).schedule;
			job.schedule = normalized;
			job.nextRunAt = job.schedule.kind === 'event' ? null : getScheduleNextRun(job.schedule, new Date());
		}
		if (typeof definition.cooldownMinutes === 'number') job.cooldownMinutes = definition.cooldownMinutes;
		job.notePath = notePath;
		if (job.enabled && job.status !== 'scheduled' && job.status !== 'running') {
			job.status = 'scheduled';
			job.lastStatus = null;
		}
	}

	/** Imports stray definition notes, then writes a note for every job. Returns notes written. */
	async syncAll(): Promise<number> {
		if (!this.plugin.settings.scheduleNotesEnabled || this.syncing) return 0;
		this.syncing = true;
		let written = 0;
		try {
			await this.plugin.ensureFolder(this.folder);
			const folder = this.plugin.app.vault.getAbstractFileByPath(this.folder);
			if (folder && 'children' in folder) {
				for (const child of (folder as { children: TAbstractFile[] }).children) {
					if (!(child instanceof TFile) || child.extension !== 'md') continue;
					const tracked = this.plugin.jobs.some(job => job.notePath === child.path);
					if (tracked) continue;
					if (await this.importNote(child)) written += 1;
				}
			}
			if (written) await this.plugin.saveState();
			for (const job of [...this.plugin.jobs]) {
				const path = this.notePathFor(job);
				const content = this.renderNote(job);
				const existing = this.plugin.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					const current = await this.plugin.app.vault.read(existing);
					if (current !== content) {
						await this.writeFile(path, content);
						written += 1;
					} else {
						this.lastWritten.set(path, content);
					}
				} else {
					await this.writeFile(path, content);
					written += 1;
				}
				job.notePath = path;
			}
			if (written) await this.plugin.saveState();
		} finally {
			this.syncing = false;
		}
		return written;
	}

	/** Debounced post-save hook; skips while the syncer itself is writing. */
	requestSync(): void {
		if (!this.plugin.settings.scheduleNotesEnabled) return;
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.syncAll().catch(error => {
				console.error('[ai-scheduler] schedule note sync failed:', error);
			});
		}, 600);
	}

	/** Vault watcher for edits, deletions, and renames inside the folder. */
	async handleVaultChange(file: TAbstractFile, eventType: 'modify' | 'delete' | 'rename', oldPath?: string): Promise<void> {
		if (!this.plugin.settings.scheduleNotesEnabled || this.syncing) return;
		if (!file || !file.path) return;
		const folder = this.folder;
		const watchPath = eventType === 'rename' ? oldPath || file.path : file.path;
		if (!ScheduleNotesSync.isInside(folder, watchPath) && !ScheduleNotesSync.isInside(folder, file.path)) return;
		if (eventType === 'rename') {
			const job = this.plugin.jobs.find(candidate => candidate.notePath === oldPath);
			if (job && ScheduleNotesSync.isInside(folder, file.path) && file instanceof TFile) {
				job.notePath = file.path;
				this.lastWritten.delete(oldPath || '');
				await this.plugin.saveState();
			}
			return;
		}
		if (eventType === 'delete') {
			const job = this.plugin.jobs.find(candidate => candidate.notePath === watchPath);
			if (job) {
				job.notePath = null;
				await this.plugin.deleteJob(job);
			}
			this.lastWritten.delete(watchPath);
			return;
		}
		// modify
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const content = await this.plugin.app.vault.read(file);
		if (this.lastWritten.get(file.path) === content) return;
		this.lastWritten.set(file.path, content);
		const job = this.plugin.jobs.find(candidate => candidate.notePath === file.path);
		if (job) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			const definition = cache?.frontmatter?.['ai-scheduler'] as NoteDefinition | undefined;
			if (definition && typeof definition === 'object') {
				this.applyDefinition(job, definition, file.path);
				await this.plugin.saveState();
			}
		} else {
			await this.syncAll();
		}
	}
}
