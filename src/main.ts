/*
 * AI Scheduler - an autonomy layer for Claudian and Obsidian Copilot.
 *
 * This plugin deliberately does not call an AI provider directly. The selected
 * backend owns providers, models, permissions, and vault tools; this plugin
 * owns when the agent should wake up and what should happen after it replies.
 *
 * Scheduling engine notes: one 15-second dispatcher serves every schedule
 * kind, including cron. Cron expressions are evaluated by the vendored,
 * dependency-free engine in src/cron (adapted from cron-parser's semantics,
 * the same library obsidian-cron relies on), and per-job bookkeeping always
 * releases its lock in a finally block so a crashed run can never wedge a
 * schedule.
 */
import { Notice, Plugin, TFile, TFolder, normalizePath } from 'obsidian';
import { ActivityEntry, AISettings, BACKEND_INFO, Job, JobOutput, ScheduleKind, TaskSchedule } from './types';
import { DEFAULT_SETTINGS, normalizeJob, parseStoredData } from './settings';
import {
	getScheduleNextRun,
	nextDailyRun,
	normalizeMaxIterations,
	validClock,
} from './schedule';
import {
	planStartupCatchUp,
	dueJobs,
	reconcileAfterRun,
	recoverInterruptedRuns,
	rescheduleEnabledJob,
	skipMissedJob,
} from './engine';
import { executionPrompt, plannerPrompt, refinePrompt, reviewPrompt } from './prompts';
import { getPathsContext, getVaultContextOptions, JobContext } from './context';
import * as backends from './backends';
import { extractJson, errorText, formatDate, formatDuration, isDisabledTask, isNightlyReviewJob, localDateKey, localTimestampKey, logActivityEntry, sendSystemNotification, sleep, validateJobSchema } from './util';
import { AssistantModal } from './ui/AssistantModal';
import { PlannerModal } from './ui/PlannerModal';
import { AssistantSettingTab } from './ui/SettingsTab';
import { ChangelogModal } from './ui/ChangelogModal';
import { ScheduleNotesSync } from './notes';

const TICK_MS = 15000;

export { AISchedulerPlugin as default };

export class AISchedulerPlugin extends Plugin {
	settings: AISettings = DEFAULT_SETTINGS;
	jobs: Job[] = [];
	deletedJobs: Job[] = [];
	activity: ActivityEntry[] = [];
	running = false;
	reviewRunning = false;
	lastTickError: string | null = null;
	notesSync: ScheduleNotesSync = new ScheduleNotesSync(this);
	pendingVaultEvents: string[] = [];
	runningJobs = new Set<string>();
	isPlanning = false;
	activePlanningGoal: string | null = null;
	private selfWrites = new Set<string>();
	private statusBarEl: HTMLElement | null = null;
	private statusBarTimer: number | null = null;

	markSelfWrite(path: string): void {
		const norm = normalizePath(path);
		this.selfWrites.add(norm);
		window.setTimeout(() => {
			this.selfWrites.delete(norm);
		}, 3000);
	}

	async onload(): Promise<void> {
		const data = await this.loadData() as Record<string, unknown> | null;
		const parsed = parseStoredData(data);
		this.settings = parsed.settings;
		this.jobs = parsed.jobs;
		this.deletedJobs = parsed.deletedJobs;
		this.activity = parsed.activity;
		recoverInterruptedRuns(this.jobs);

		this.assignTaskNumbers();
		this.running = false;
		this.reviewRunning = false;
		this.lastTickError = null;

		if (typeof this.addStatusBarItem === 'function') {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass('ai-scheduler-status-bar');
			this.statusBarEl.hide();
			this.updateStatusBar();
		}

		this.addRibbonIcon('brain', 'Open AI Scheduler', () => new AssistantModal(this.app, this).open());
		this.addCommand({
			id: 'open-assistant',
			name: 'Open assistant dashboard',
			callback: () => new AssistantModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'plan-with-ai',
			name: 'Ask AI to plan a schedule',
			callback: () => new PlannerModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'run-daily-review',
			name: 'Run AI daily preview',
			callback: () => this.startReviewRun(true, 'daily'),
		});
		this.addCommand({
			id: 'run-nightly-review',
			name: 'Run AI nightly review now',
			callback: () => this.startReviewRun(true, 'nightly'),
		});
		this.addCommand({
			id: 'enable-nightly-review',
			name: 'Enable nightly AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = true;
				await this.ensureNightlyReviewJob();
				await this.saveState();
				new Notice('Nightly AI review enabled');
			},
		});
		this.addCommand({
			id: 'disable-nightly-review',
			name: 'Disable nightly AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = false;
				await this.ensureNightlyReviewJob();
				await this.saveState();
				new Notice('Nightly AI review disabled');
			},
		});
		this.addCommand({
			id: 'toggle-nightly-review',
			name: 'Toggle nightly AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = !this.settings.nightlyReviewEnabled;
				await this.ensureNightlyReviewJob();
				await this.saveState();
				new Notice(this.settings.nightlyReviewEnabled ? 'Nightly AI review enabled' : 'Nightly AI review disabled');
			},
		});
		this.addCommand({
			id: 'enable-all-jobs',
			name: 'Enable all scheduled tasks',
			callback: async () => {
				const userTasks = this.jobs.filter(j => !isNightlyReviewJob(j));
				if (userTasks.length === 0) {
					new Notice('No tasks available.');
					return;
				}
				const count = await this.enableAllJobs();
				new Notice(count > 0 ? `${count} scheduled task(s) enabled.` : 'All scheduled tasks are already enabled.');
			},
		});
		this.addCommand({
			id: 'disable-all-jobs',
			name: 'Disable all scheduled tasks',
			callback: async () => {
				const userTasks = this.jobs.filter(j => !isNightlyReviewJob(j));
				if (userTasks.length === 0) {
					new Notice('No tasks available.');
					return;
				}
				const count = await this.disableAllJobs();
				new Notice(count > 0 ? `${count} scheduled task(s) disabled.` : 'All scheduled tasks are already disabled.');
			},
		});
		this.addCommand({
			id: 'restore-last-deleted-task',
			name: 'Restore last deleted task',
			callback: async () => {
				const restored = await this.restoreLastDeletedJob();
				if (restored) {
					new Notice(`Restored task #${restored.taskNumber}: ${restored.title}`);
				} else {
					new Notice('No deleted tasks to restore.');
				}
			},
		});
		this.addCommand({
			id: 'sync-schedule-notes',
			name: 'Sync schedule notes now',
			callback: async () => {
				if (!this.settings.scheduleNotesEnabled) {
					new Notice('Schedule notes are not enabled in settings.');
					return;
				}
				try {
					const written = await this.notesSync.syncAll();
					new Notice(written ? `${written} note(s) reconciled.` : 'All schedule notes are up to date.');
				} catch (error) {
					new Notice(`Could not sync schedule notes: ${errorText(error)}`, 8000);
				}
			},
		});
		this.addCommand({
			id: 'view-changelog',
			name: 'View changelog / what\'s new',
			callback: () => new ChangelogModal(this.app, this).open(),
		});
		this.addSettingTab(new AssistantSettingTab(this.app, this));

		this.registerInterval(window.setInterval(() => { void this.tick(); }, TICK_MS));
		this.registerEvent(this.app.vault.on('modify', file => {
			void this.handleVaultChange(file);
			void this.notesSync.handleVaultChange(file, 'modify');
		}));
		this.registerEvent(this.app.vault.on('create', file => {
			void this.handleVaultChange(file);
			void this.notesSync.handleVaultChange(file, 'modify');
		}));
		this.registerEvent(this.app.vault.on('delete', file => {
			void this.notesSync.handleVaultChange(file, 'delete');
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			void this.notesSync.handleVaultChange(file, 'rename', oldPath);
		}));

		if (this.settings.nightlyReviewEnabled) await this.ensureNightlyReviewJob();
		await this.saveState();

		// Check for changelog notification on update (only fires once per update when layout is ready)
		const currentVersion = this.manifest.version;
		const previousVersion = this.settings.lastSeenVersion;
		this.settings.lastSeenVersion = currentVersion;
		await this.saveState();

		if (this.settings.showChangelogOnUpdate && previousVersion && previousVersion !== currentVersion) {
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => {
					new ChangelogModal(this.app, this, {
						fromVersion: previousVersion,
						currentVersion,
						isAutomatic: true,
					}).open();
				}, 600);
			});
		}

		await this.catchUpOnStart();
		if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
	}

	onunload(): void {
		if (this.statusBarTimer !== null) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		this.statusBarEl?.remove();
		this.statusBarEl = null;
	}

	async saveState(): Promise<void> {
		try {
			await this.saveData({
				version: 6,
				settings: this.settings,
				jobs: this.jobs,
				deletedJobs: this.deletedJobs.slice(0, 100),
				activity: this.activity.slice(-50),
			});
		} catch (error) {
			console.error('[ai-scheduler] Failed to save state:', error);
		}
		this.notesSync.requestSync();
	}

	assignTaskNumbers(): void {
		const used = new Set<number>();
		let next = 1;
		for (const job of this.jobs) {
			const existing = Number(job.taskNumber);
			if (Number.isInteger(existing) && existing > 0 && !used.has(existing)) {
				used.add(existing);
				next = Math.max(next, existing + 1);
				job.taskNumber = existing;
				continue;
			}
			while (used.has(next)) next += 1;
			job.taskNumber = next;
			used.add(next);
			next += 1;
		}
		for (const job of this.jobs) {
			if (!isNightlyReviewJob(job) && !job.enabled && job.status === 'scheduled') {
				job.status = 'disabled';
				job.lastStatus = 'disabled';
			}
		}
	}

	logActivity(type: string, message: string, jobId: string | null = null): void {
		logActivityEntry(this.activity, type, message, jobId);
	}

	async clearActivity(): Promise<void> {
		this.activity = [];
		await this.saveState();
	}

	async catchUpOnStart(): Promise<void> {
		const now = Date.now();
		const plan = planStartupCatchUp(this.jobs, this.settings, now);
		for (const job of plan.stale) skipMissedJob(job);
		if (!this.settings.catchUpOnStart) {
			if (plan.stale.length) await this.saveState();
			return;
		}
		if (plan.missed.length || plan.stale.length) {
			if (plan.missed.length) {
				this.logActivity('startup', `Found ${plan.missed.length} task(s) due while Obsidian was closed`);
			}
			await this.saveState();
		}
		if (plan.missed.length) {
			new Notice(`${plan.missed.length} AI task(s) are ready after startup`, 6000);
		}
		await sleep(1000);
		await this.tick();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		const due = dueJobs(this.jobs, Date.now());
		if (!due.length) {
			if (this.pendingVaultEvents.length) {
				const events = this.pendingVaultEvents.splice(0);
				for (const path of events) await this.handleVaultChange({ path });
			}
			return;
		}
		this.running = true;
		try {
			for (const job of due) {
				if (this.runningJobs.has(job.id)) continue;
				await this.executeJob(job);
			}
		} finally {
			this.running = false;
		}
		if (this.pendingVaultEvents.length) {
			const events = this.pendingVaultEvents.splice(0);
			for (const path of events) await this.handleVaultChange({ path });
		}
	}

	async executeJob(job: Job): Promise<void> {
		if (this.runningJobs.has(job.id)) return;
		this.runningJobs.add(job.id);
		this.updateStatusBar();
		try {
			await this.runJobBody(job);
		} finally {
			this.runningJobs.delete(job.id);
			this.updateStatusBar();
		}
	}

	private async runJobBody(job: Job): Promise<void> {
		job.status = 'running';
		job.lastRunAt = new Date().toISOString();
		job.attempts = Number(job.attempts || 0) + 1;
		this.logActivity('running', `Task #${job.taskNumber} started: ${job.title}`, job.id);
		if (job.notify !== false) {
			new Notice(`AI Scheduler: Task #${job.taskNumber} started (${job.title})...`, 4000);
		}
		this.updateStatusBar();
		await this.saveState();
		try {
			const execution = await backends.resolveJobExecution(this, job);
			Object.assign(job, {
				profile: execution.modelRef || null,
				tab: execution.tab,
				conversationId: execution.conversationId,
				providerId: execution.providerId,
				model: execution.model,
			});
			await this.saveState();
			const context = this.getJobContext(job);
			const prompt = job.routine === 'daily-review'
				? ''
				: executionPrompt(job.prompt, context.paths);
			const reply = job.routine === 'daily-review'
				? await this.runDailyReview(false, execution, 'nightly')
				: await backends.sendToAI(this, prompt, execution, context);
			const trimmedReply = (reply || '').trim();
			if (!trimmedReply) {
				throw new Error('The AI returned an empty response.');
			}
			job.lastReply = reply || '';
			job.lastStatus = 'completed';
			job.lastError = null;
			job.status = 'completed';
			job.runCount = Number(job.runCount || 0) + 1;
			await this.processFollowUps(reply, job);
			if (job.output && job.output.folder && reply) {
				const writtenPath = await this.writeOutput(job.output.folder, job.output.filename, reply);
				job.lastOutputPath = writtenPath;
				if (!job.lastOutputFiles) job.lastOutputFiles = [];
				if (!job.lastOutputFiles.includes(writtenPath)) {
					job.lastOutputFiles.push(writtenPath);
				}
			}
			reconcileAfterRun(job);
			this.logActivity('completed', `Task #${job.taskNumber} finished: ${job.title}`, job.id);
			if (this.settings.notifyOnCompletion && job.notify !== false) {
				new Notice(`AI completed: ${job.title}`, 5000);
			}
			if (this.settings.systemNotifications && job.notify !== false) {
				sendSystemNotification('AI Scheduler', `AI completed: ${job.title}`);
			}
		} catch (error) {
			job.status = 'failed';
			job.lastStatus = 'failed';
			job.lastError = errorText(error);
			reconcileAfterRun(job, { failed: true });
			this.lastTickError = job.lastError;
			this.logActivity('failed', `Task #${job.taskNumber} failed: ${job.title} (${job.lastError})`, job.id);
			new Notice(`AI task failed: ${job.title}\n${job.lastError}`, 8000);
			if (this.settings.systemNotifications) {
				sendSystemNotification('AI Scheduler', `AI task failed: ${job.title}`);
			}
		}
		await this.saveState();
	}

	async handleVaultChange(file: { path?: string }): Promise<void> {
		if (!file || !file.path) return;
		const normPath = normalizePath(file.path);
		if (this.selfWrites.has(normPath)) return;
		const normReport = normalizePath(this.settings.reportFolder || 'AI Reviews');
		const normSchedule = normalizePath(this.settings.scheduleFolder || 'AI Schedules');
		if (ScheduleNotesSync.isInside(normReport, normPath) || ScheduleNotesSync.isInside(normSchedule, normPath)) {
			return;
		}
		if (this.running) {
			this.pendingVaultEvents.push(file.path);
			return;
		}
		const eventJobs = this.jobs.filter(job => job.enabled && job.schedule && job.schedule.kind === 'event'
			&& (!job.schedule.event || job.schedule.event === 'modify' || job.schedule.event === 'vault-change'));
		if (!eventJobs.length) return;
		const now = Date.now();
		for (const job of eventJobs) {
			const cooldown = Math.max(0, Number(job.cooldownMinutes) || 10) * 60000;
			if (job.lastRunAt && now - new Date(job.lastRunAt).getTime() < cooldown) continue;
			job.nextRunAt = new Date(now + 2000).toISOString();
			job.lastEventPath = file.path;
		}
		await this.saveState();
	}

	async addJob(raw: Record<string, unknown>): Promise<Job> {
		const job = normalizeJob(raw);
		if (job.schedule.kind !== 'event' && !job.nextRunAt) {
			throw new Error(`Cannot create "${job.title}": its schedule is invalid or has no valid time.`);
		}
		this.assignTaskNumbers();
		job.taskNumber = Math.max(0, ...this.jobs.map(candidate => Number(candidate.taskNumber) || 0)) + 1;
		this.jobs.push(job);
		await this.saveState();
		return job;
	}

	async ensureNightlyReviewJob(): Promise<void> {
		let job = this.jobs.find(candidate => candidate.routine === 'daily-review');
		if (!this.settings.nightlyReviewEnabled) {
			if (job) {
				job.enabled = false;
				job.nextRunAt = null;
				job.status = 'disabled';
				job.lastStatus = 'disabled';
			}
			return;
		}
		if (!validClock(this.settings.reviewTime)) {
			new Notice('AI Scheduler: review time is invalid, nightly review not scheduled.');
			return;
		}
		if (!job) {
			job = normalizeJob({
				id: 'nightly-daily-review',
				title: 'Nightly daily review',
				prompt: '',
				tab: this.settings.assistantTab,
				routine: 'daily-review',
				schedule: { kind: 'daily', time: this.settings.reviewTime },
				notify: true,
			});
			this.jobs.push(job);
		} else {
			job.enabled = true;
			job.status = 'scheduled';
			job.lastStatus = null;
			job.tab = this.settings.assistantTab;
			job.schedule = { kind: 'daily', time: this.settings.reviewTime };
			job.nextRunAt = nextDailyRun(this.settings.reviewTime);
		}
	}

	async startReviewRun(manual = true, kind: 'daily' | 'nightly' = 'daily'): Promise<void> {
		if (this.reviewRunning) {
			new Notice('A review is already running. You can keep using Obsidian while it finishes.', 5000);
			return;
		}
		new Notice(`${kind === 'nightly' ? 'Nightly' : 'Daily'} review started. It will create ${this.settings.reportFolder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7000);
		void this.runDailyReview(manual, null, kind).catch(error => {
			this.logActivity('failed', `Review failed: ${errorText(error)}`);
			new Notice(`Review failed: ${errorText(error)}`, 8000);
			void this.saveState();
		});
	}

	async runDailyReview(manual: boolean, execution: backends.ResolvedExecution | null = null, kind: 'daily' | 'nightly' = 'daily'): Promise<string> {
		if (this.reviewRunning) {
			throw new Error('A review is already in progress.');
		}
		this.reviewRunning = true;
		this.updateStatusBar();
		try {
			const now = new Date();
			const today = localDateKey(now);
			const start = new Date();
			start.setHours(0, 0, 0, 0);
			const files = this.app.vault.getMarkdownFiles()
				.filter(file => this.includeReviewFile(file, start))
				.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const fileList = files.length ? files.map(file => `- ${file.path}`).join('\n') : '- No Markdown files were created or modified today.';
			const prompt = reviewPrompt(kind, today, fileList);
			const nightlyJob = this.jobs.find(candidate => candidate.routine === 'daily-review');
			const model = kind === 'nightly' ? this.settings.nightlyReviewModel : this.settings.dailyReviewModel;
			const resolved = execution || (nightlyJob && kind === 'nightly'
				? await backends.resolveJobExecution(this, nightlyJob)
				: await backends.resolveModel(this, model, kind === 'nightly' ? 'nightly review' : 'daily preview'));
			const context = getPathsContext(this.app, files.map(file => file.path));
			const reply = await backends.sendToAI(this, prompt, resolved, context);
			const reportTitle = kind === 'nightly' ? 'Nightly Review' : 'Daily Preview';
			const report = reply || `# ${reportTitle} - ${today}\n\nThe active AI backend did not return a report.`;
			const timestamp = localTimestampKey(now);
			let filename = `${timestamp}.md`;
			let suffix = 2;
			while (this.app.vault.getAbstractFileByPath(normalizePath(`${this.settings.reportFolder}/${filename}`))) {
				filename = `${timestamp}-${suffix}.md`;
				suffix += 1;
			}
			const path = `${this.settings.reportFolder}/${filename}`;
			await this.writeOutput(this.settings.reportFolder, filename, `# ${reportTitle} - ${today}\n\nGenerated: ${formatDate(now.toISOString())}\n\n${report}`);
			if (nightlyJob) {
				nightlyJob.lastOutputPath = path;
				if (!nightlyJob.lastOutputFiles) nightlyJob.lastOutputFiles = [];
				if (!nightlyJob.lastOutputFiles.includes(path)) {
					nightlyJob.lastOutputFiles.push(path);
				}
			}
			this.logActivity('review', `Daily review written to ${path}`);
			if (manual || this.settings.notifyOnCompletion) {
				new Notice(`Review written to ${path}`, 6000);
			}
			if (this.settings.systemNotifications) {
				sendSystemNotification('AI Scheduler', `Review written to ${path}`);
			}
			await this.saveState();
			return report;
		} finally {
			this.reviewRunning = false;
			this.updateStatusBar();
		}
	}

	includeReviewFile(file: { path: string; stat: { mtime: number } }, start: Date): boolean {
		if (!file || !file.path) return false;
		const normPath = normalizePath(file.path);
		const normReport = normalizePath(this.settings.reportFolder || 'AI Reviews');
		const normSchedule = normalizePath(this.settings.scheduleFolder || 'AI Schedules');
		if (ScheduleNotesSync.isInside(normReport, normPath) || ScheduleNotesSync.isInside(normSchedule, normPath)) {
			return false;
		}
		if (this.settings.reviewContextMode === 'all-markdown') return true;
		if (this.settings.reviewContextMode === 'no-files') return false;
		return Boolean(file.stat && file.stat.mtime >= start.getTime());
	}

	getVaultContextOptions() {
		return getVaultContextOptions(this.app);
	}

	getPathsContext(paths: string[]): JobContext {
		return getPathsContext(this.app, paths);
	}

	validateContextPaths(paths: string[]): string[] {
		if (!Array.isArray(paths)) return [];
		const available = this.getVaultContextOptions();
		const known = new Set(available.map(option => option.path));
		return paths.filter(path => known.has(path));
	}

	getJobContext(job: Job): JobContext {
		const context = getPathsContext(this.app, job && job.contextPaths);
		if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(', ')}`);
		return context;
	}

	async writeOutput(folder: string, filename: string | undefined, content: string): Promise<string> {
		const cleanFolder = normalizePath(String(folder || '').replace(/^\/+|\/+$/g, ''));
		let cleanName = String(filename || `${localDateKey()}.md`).replace(/[\\/]/g, '-');
		let path = normalizePath(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
		this.markSelfWrite(path);
		await this.ensureFolder(cleanFolder);
		let existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			let suffix = 2;
			while (existing instanceof TFolder) {
				cleanName = cleanName.replace(/(\.md)?$/, `-${suffix}.md`);
				path = normalizePath(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
				existing = this.app.vault.getAbstractFileByPath(path);
				suffix += 1;
			}
		}
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			try {
				await this.app.vault.create(path, content);
			} catch (err) {
				const retryFile = this.app.vault.getAbstractFileByPath(path);
				if (retryFile instanceof TFile) {
					await this.app.vault.modify(retryFile, content);
				} else if (errorText(err).includes('already exists')) {
					try {
						await this.app.vault.adapter.write(path, content);
					} catch { /* ignore if already written */ }
				} else {
					throw err;
				}
			}
		}
		return path;
	}

	async ensureFolder(folder: string): Promise<void> {
		if (!folder) return;
		const parts = folder.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try { await this.app.vault.createFolder(current); } catch { /* another operation may have created it */ }
			}
		}
	}

	async processFollowUps(reply: string, parentJob: Job): Promise<void> {
		const MAX_TOTAL_JOBS = 100;
		const plans = extractJson(reply)
			.map(item => validateJobSchema(item))
			.filter((item): item is Record<string, unknown> => Boolean(item));
		for (const plan of plans.slice(0, 3)) {
			if (this.jobs.length >= MAX_TOTAL_JOBS) {
				console.warn('[ai-scheduler] Follow-up skipped: job limit reached');
				break;
			}
			await this.addJob(Object.assign(
				this.jobFromPlan(plan, parentJob.tab, 'self-talk'),
				{
					profile: parentJob.profile || null,
					conversationId: parentJob.conversationId || null,
					providerId: parentJob.providerId || null,
					model: parentJob.model || null,
					contextPaths: parentJob.contextPaths || [],
				},
			));
		}
	}

	jobFromPlan(plan: Record<string, unknown>, fallbackTab: number, source: string): Partial<Job> & Record<string, unknown> {
		const schedule = (plan.schedule || {}) as Record<string, unknown>;
		const normalized: TaskSchedule = {
			kind: (String(schedule.kind) || 'once') as ScheduleKind,
			at: schedule.at as string | undefined,
			time: schedule.time as string | undefined,
			days: schedule.days as number[] | undefined,
			rules: schedule.rules as TaskSchedule['rules'],
			intervalMinutes: (schedule.intervalMinutes || schedule.everyMinutes || (Number(schedule.everyHours || 0) * 60)) as number | null,
			maxIterations: normalizeMaxIterations(schedule.maxIterations || schedule.maxRuns || schedule.iterations),
			event: schedule.event as string | undefined,
			expression: schedule.expression as string | undefined,
		};
		const planRecord = plan as {
			tab?: number;
			profile?: string | null;
			conversationId?: string | null;
			providerId?: string | null;
			model?: string | null;
			output?: JobOutput | null;
			notify?: boolean;
			contextPaths?: string[];
			cooldownMinutes?: number;
		};
		const context = plan.context as { paths?: string[] } | undefined;
		const titleStr = typeof plan.title === 'string' ? plan.title : 'Assistant task';
		const promptCandidate = typeof plan.prompt === 'string' && plan.prompt.trim()
			? plan.prompt.trim()
			: (typeof plan.instructions === 'string' && plan.instructions.trim()
				? plan.instructions.trim()
				: (typeof plan.action === 'string' && plan.action.trim()
					? plan.action.trim()
					: (typeof plan.task === 'string' && plan.task.trim()
						? plan.task.trim()
						: (typeof plan.description === 'string' && plan.description.trim()
							? plan.description.trim()
							: titleStr))));
		const doubt = typeof plan.doubt === 'string' && plan.doubt.trim()
			? plan.doubt.trim()
			: (typeof plan.clarification === 'string' && plan.clarification.trim()
				? plan.clarification.trim()
				: null);
		const nextRunAt = normalized.kind === 'event' ? null : getScheduleNextRun(normalized);
		if (normalized.kind !== 'event' && !nextRunAt) {
			throw new Error(`Invalid schedule for "${titleStr}": no valid next run time`);
		}
		return {
			title: titleStr.slice(0, 120),
			prompt: promptCandidate,
			doubt,
			tab: Number(planRecord.tab || fallbackTab || this.settings.assistantTab),
			profile: planRecord.profile || null,
			conversationId: planRecord.conversationId || null,
			providerId: planRecord.providerId || null,
			model: planRecord.model || null,
			schedule: normalized,
			nextRunAt,
			output: planRecord.output || null,
			notify: planRecord.notify !== false,
			contextPaths: Array.isArray(planRecord.contextPaths) ? planRecord.contextPaths : Array.isArray(context?.paths) ? context.paths : [],
			cooldownMinutes: planRecord.cooldownMinutes || (schedule.cooldownMinutes as number | undefined),
			source,
		};
	}

	async planAndCreate(goal: string, contextPaths: string[] = [], resultFolder = ''): Promise<{ reply: string; jobs: Job[] }> {
		this.isPlanning = true;
		this.activePlanningGoal = goal;
		this.updateStatusBar();
		try {
			const execution = await backends.resolveModel(this, this.settings.planningModel, 'AI planning');
			const validatedPaths = this.validateContextPaths(contextPaths);
			const prompt = plannerPrompt(goal, validatedPaths);
			const context = getPathsContext(this.app, validatedPaths);
			const reply = await backends.sendToAI(this, prompt, execution, context);
			const plans = extractJson(reply)
				.map(item => validateJobSchema(item))
				.filter((item): item is Record<string, unknown> => Boolean(item));
			if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
			const jobs: Job[] = [];
			for (const plan of plans.slice(0, 10)) {
				const planRecord = plan as { contextPaths?: string[]; context?: { paths?: string[] }; output?: JobOutput | null };
				const newJob = await this.addJob(Object.assign(
					this.jobFromPlan(Object.assign({}, plan, {
						contextPaths: planRecord.contextPaths || (planRecord.context && planRecord.context.paths) || validatedPaths,
						output: planRecord.output || (resultFolder ? { folder: resultFolder } : null),
					}), execution.tab as number, 'planner'),
					{ profile: execution.modelRef, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model },
				));
				jobs.push(newJob);
				if (newJob.doubt) {
					new Notice(`AI Planning Note: ${newJob.doubt}`, 9000);
				}
				this.logActivity('planned', `AI created Task #${newJob.taskNumber}: ${newJob.title}${newJob.doubt ? ` (${newJob.doubt})` : ''}`, newJob.id);
			}
			await this.saveState();
			return { reply, jobs };
		} finally {
			this.isPlanning = false;
			this.activePlanningGoal = null;
			this.updateStatusBar();
		}
	}

	async refineJob(job: Job, request: string, contextPaths: string[] = job.contextPaths || []): Promise<{ title: string; prompt: string; schedule: TaskSchedule }> {
		const execution = await backends.resolveModel(this, this.settings.planningModel, 'AI task editing');
		const prompt = refinePrompt(job, request, contextPaths);
		const context = getPathsContext(this.app, contextPaths);
		if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(', ')}`);
		const reply = await backends.sendToAI(this, prompt, execution, context);
		const plan = extractJson(reply)[0] as { title?: string; prompt?: string; schedule?: TaskSchedule };
		if (!plan || !plan.title || !plan.prompt || !plan.schedule) throw new Error('The AI returned an invalid job edit.');
		return plan as { title: string; prompt: string; schedule: TaskSchedule };
	}

	backendInfo(mode = this.settings.backendMode) {
		return BACKEND_INFO[mode === 'copilot' ? 'copilot' : 'claudian'];
	}

	async checkBackendSetup(mode = this.settings.backendMode) {
		return backends.checkBackendSetup(this, mode);
	}

	checkCopilotSetup() {
		return backends.checkCopilotSetup(this);
	}

	checkClaudianSetup() {
		return backends.checkClaudianSetup(this);
	}

	getClaudianPlugin() {
		return backends.getClaudianPlugin(this);
	}

	getCopilotPlugin() {
		return backends.getCopilotPlugin(this);
	}

	getModelOptions() {
		return backends.getModelOptions(this);
	}

	async refreshModels() {
		return backends.refreshModels(this);
	}

	openSettingsTab(): void {
		const appWithSetting = this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } };
		if (appWithSetting.setting && typeof appWithSetting.setting.open === 'function') {
			appWithSetting.setting.open();
			if (typeof appWithSetting.setting.openTabById === 'function') {
				appWithSetting.setting.openTabById(this.manifest.id);
			}
		}
	}

	getBackendReadiness(): { ok: boolean; message: string } {
		const mode = this.settings.backendMode;
		if (mode === 'none' || !mode) {
			return { ok: false, message: 'No AI backend selected. Choose Claudian or Obsidian Copilot in AI Scheduler settings.' };
		}
		if (mode === 'copilot') {
			const copilot = this.getCopilotPlugin();
			if (!copilot) {
				return { ok: false, message: 'Obsidian Copilot plugin is not installed or enabled.' };
			}
			const check = this.checkCopilotSetup();
			if (!check.ok) {
				return { ok: false, message: check.message };
			}
			return { ok: true, message: 'Obsidian Copilot is ready.' };
		} else {
			const claudian = this.getClaudianPlugin();
			if (!claudian) {
				return { ok: false, message: 'Claudian plugin is not installed or enabled.' };
			}
			const models = this.getModelOptions();
			if (!models.length) {
				return { ok: false, message: 'No Claudian models found. Open Claudian to configure providers and API keys, then refresh models in Settings.' };
			}
			if (!this.settings.planningModel && !this.settings.executionModel) {
				return { ok: false, message: 'No AI model selected for tasks or planning. Please choose a model in AI Scheduler settings.' };
			}
			return { ok: true, message: 'Claudian is ready.' };
		}
	}

	testNotification(): void {
		new Notice('AI Scheduler notifications are working.');
		const sentSystem = sendSystemNotification('AI Scheduler', 'AI Scheduler desktop notifications are working.');
		if (!sentSystem && typeof window !== 'undefined' && typeof window.Notification !== 'undefined' && window.Notification.permission === 'denied') {
			new Notice('System desktop notifications are blocked by windows/Obsidian permissions.', 6000);
		}
		this.logActivity('notification', 'Test notification sent');
		void this.saveState();
	}

	async deleteJob(job: Job): Promise<void> {
		this.jobs = this.jobs.filter(candidate => candidate.id !== job.id);
		this.deletedJobs = [job, ...this.deletedJobs.filter(candidate => candidate.id !== job.id)].slice(0, 100);
		if (job.notePath) {
			const file = this.app.vault.getAbstractFileByPath(job.notePath);
			if (file instanceof TFile) {
				try {
					await this.app.fileManager.trashFile(file);
				} catch (error) {
					console.error('[ai-scheduler] Failed to trash schedule note on deletion:', error);
				}
			}
			this.notesSync.forgetPath(job.notePath);
		}
		this.logActivity('deleted', `Deleted task #${job.taskNumber}: ${job.title}`, job.id);
		await this.saveState();
	}

	async restoreJob(job: Job): Promise<void> {
		this.deletedJobs = this.deletedJobs.filter(candidate => candidate.id !== job.id);
		if (!this.jobs.some(j => j.id === job.id)) {
			job.notePath = null;
			job.lastError = null;
			if (job.enabled) {
				job.status = 'scheduled';
				job.lastStatus = null;
				rescheduleEnabledJob(job);
			} else {
				job.status = 'disabled';
				job.lastStatus = 'disabled';
				job.nextRunAt = null;
			}
			this.jobs.push(job);
			this.assignTaskNumbers();
			this.logActivity('restored', `Restored task #${job.taskNumber}: ${job.title}`, job.id);
			await this.saveState();
		}
	}

	async restoreAllJobs(): Promise<number> {
		const toRestore = [...this.deletedJobs];
		let count = 0;
		for (const job of toRestore) {
			if (!this.jobs.some(j => j.id === job.id)) {
				job.notePath = null;
				job.lastError = null;
				if (job.enabled) {
					job.status = 'scheduled';
					job.lastStatus = null;
					rescheduleEnabledJob(job);
				} else {
					job.status = 'disabled';
					job.lastStatus = 'disabled';
					job.nextRunAt = null;
				}
				this.jobs.push(job);
				count++;
			}
		}
		this.deletedJobs = [];
		if (count > 0) {
			this.assignTaskNumbers();
			this.logActivity('restored', `Restored ${count} task(s) from trash`);
			await this.saveState();
		}
		return count;
	}

	async permanentlyDeleteJob(job: Job): Promise<void> {
		this.deletedJobs = this.deletedJobs.filter(candidate => candidate.id !== job.id);
		this.logActivity('deleted', `Permanently removed task #${job.taskNumber}: ${job.title}`, job.id);
		await this.saveState();
	}

	async emptyTrash(): Promise<number> {
		const count = this.deletedJobs.length;
		this.deletedJobs = [];
		if (count > 0) {
			this.logActivity('deleted', `Emptied trash (${count} task(s) permanently removed)`);
			await this.saveState();
		}
		return count;
	}

	async restoreLastDeletedJob(): Promise<Job | null> {
		if (this.deletedJobs.length === 0) return null;
		const job = this.deletedJobs[0];
		await this.restoreJob(job);
		return job;
	}

	async disableAllJobs(): Promise<number> {
		let count = 0;
		for (const job of this.jobs.filter(candidate => !isNightlyReviewJob(candidate) && candidate.enabled)) {
			job.enabled = false;
			job.nextRunAt = null;
			job.status = 'disabled';
			job.lastStatus = 'disabled';
			count++;
		}
		if (count > 0) {
			this.logActivity('status', `Disabled ${count} scheduled task(s)`);
			await this.saveState();
		}
		return count;
	}

	async enableJob(job: Job): Promise<void> {
		job.enabled = true;
		job.status = 'scheduled';
		job.lastStatus = null;
		job.lastError = null;
		rescheduleEnabledJob(job);
		await this.saveState();
	}

	async enableAllJobs(): Promise<number> {
		let count = 0;
		for (const job of this.jobs.filter(candidate => !isNightlyReviewJob(candidate) && isDisabledTask(candidate))) {
			job.enabled = true;
			job.status = 'scheduled';
			job.lastStatus = null;
			job.lastError = null;
			rescheduleEnabledJob(job);
			count++;
		}
		if (count > 0) {
			this.logActivity('status', `Enabled ${count} scheduled task(s)`);
			await this.saveState();
		}
		return count;
	}

	async deleteAllJobs(): Promise<number> {
		const toDelete = this.jobs.filter(job => !isNightlyReviewJob(job));
		for (const job of toDelete) {
			if (job.notePath) {
				const file = this.app.vault.getAbstractFileByPath(job.notePath);
				if (file instanceof TFile) {
					try {
						await this.app.fileManager.trashFile(file);
					} catch (error) {
						console.error('[ai-scheduler] Failed to trash schedule note on deletion:', error);
					}
				}
				this.notesSync.forgetPath(job.notePath);
			}
		}
		this.jobs = this.jobs.filter(job => isNightlyReviewJob(job));
		if (toDelete.length > 0) {
			this.deletedJobs = [...toDelete.slice().reverse(), ...this.deletedJobs].slice(0, 100);
			this.logActivity('deleted', `Deleted ${toDelete.length} scheduled task(s)`);
			await this.saveState();
		}
		return toDelete.length;
	}

	async updateJob(job: Job, changes: Partial<Job> & { cooldownMinutes?: number }): Promise<void> {
		Object.assign(job, changes);
		job.schedule = Object.assign({}, job.schedule, changes.schedule || {});
		job.schedule.maxIterations = normalizeMaxIterations(job.schedule.maxIterations);
		job.nextRunAt = job.schedule.kind === 'event' ? null : getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
		job.enabled = true;
		job.status = 'scheduled';
		job.lastError = null;
		await this.saveState();
	}

	async retryJob(job: Job): Promise<void> {
		job.enabled = true;
		job.status = 'scheduled';
		job.lastStatus = null;
		job.lastError = null;
		rescheduleEnabledJob(job);
		await this.saveState();
		await this.tick();
	}

	async runJobNow(job: Job): Promise<void> {
		job.enabled = true;
		job.status = 'scheduled';
		job.lastStatus = null;
		job.lastError = null;
		job.nextRunAt = new Date(Date.now() - 1000).toISOString();
		await this.saveState();
		await this.tick();
	}

	async resetRunningJob(job: Job): Promise<void> {
		this.runningJobs.delete(job.id);
		job.status = 'failed';
		job.lastStatus = 'cancelled';
		job.lastError = 'Cancelled or reset by user';
		reconcileAfterRun(job, { failed: true });
		this.logActivity('cancelled', `Task #${job.taskNumber} cancelled/reset by user: ${job.title}`, job.id);
		this.updateStatusBar();
		await this.saveState();
	}

	updateStatusBar(): void {
		if (!this.statusBarEl) return;
		const runningList = this.jobs.filter(job => this.runningJobs.has(job.id) || job.status === 'running');
		if (runningList.length === 0 && !this.reviewRunning && !this.isPlanning) {
			if (this.statusBarTimer !== null) {
				window.clearInterval(this.statusBarTimer);
				this.statusBarTimer = null;
			}
			this.statusBarEl.empty();
			this.statusBarEl.hide();
			return;
		}

		this.statusBarEl.show();
		this.statusBarEl.empty();
		this.statusBarEl.createSpan({ cls: 'ai-scheduler-spinner-tiny ai-scheduler-status-bar-spinner' });
		const label = this.statusBarEl.createSpan({ cls: 'ai-scheduler-status-bar-text' });

		if (this.isPlanning) {
			label.setText('AI: Designing schedule plan...');
		} else if (runningList.length === 1) {
			const j = runningList[0];
			const startIso = j.lastRunAt || j.nextRunAt || new Date().toISOString();
			const duration = formatDuration(startIso);
			label.setText(`AI: #${j.taskNumber} (${j.title}) · ${duration}`);
		} else if (runningList.length > 1) {
			label.setText(`AI: ${runningList.length} tasks running...`);
		} else if (this.reviewRunning) {
			label.setText('AI: Review in progress...');
		}

		this.statusBarEl.setAttribute('title', 'AI Scheduler is running in background. Click to open dashboard.');
		this.statusBarEl.onclick = () => {
			new AssistantModal(this.app, this).open();
		};

		if (this.statusBarTimer === null) {
			this.statusBarTimer = window.setInterval(() => {
				this.updateStatusBar();
			}, 1000);
		}
	}
}

