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
import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import { ActivityEntry, AISettings, BACKEND_INFO, Job, JobOutput, ScheduleKind, TaskSchedule } from './types';
import { DEFAULT_SETTINGS, normalizeJob, parseStoredData } from './settings';
import {
	getScheduleNextRun,
	nextDailyRun,
	normalizeMaxIterations,
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
import { extractJson, errorText, formatDate, isDisabledTask, isNightlyReviewJob, localDateKey, localTimestampKey, logActivityEntry } from './util';
import { AssistantModal } from './ui/AssistantModal';
import { PlannerModal } from './ui/PlannerModal';
import { AssistantSettingTab } from './ui/SettingsTab';
import { ScheduleNotesSync } from './notes';

const TICK_MS = 15000;

export class AISchedulerPlugin extends Plugin {
	settings: AISettings = DEFAULT_SETTINGS;
	jobs: Job[] = [];
	activity: ActivityEntry[] = [];
	running = false;
	reviewRunning = false;
	lastTickError: string | null = null;
	notesSync: ScheduleNotesSync = new ScheduleNotesSync(this);
	private runningJobs = new Set<string>();

	async onload(): Promise<void> {
		const data = await this.loadData() as Record<string, unknown> | null;
		const parsed = parseStoredData(data);
		this.settings = parsed.settings;
		this.jobs = parsed.jobs;
		this.activity = parsed.activity;
		const recovered = recoverInterruptedRuns(this.jobs);

		this.assignTaskNumbers();
		this.running = false;
		this.reviewRunning = false;
		this.lastTickError = null;

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
		await this.catchUpOnStart();
		if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
		console.log(`[ai-scheduler] scheduler loaded, jobs: ${this.jobs.length}${recovered ? `, recovered ${recovered} interrupted run(s)` : ''}`);
	}

	async saveState(): Promise<void> {
		await this.saveData({ version: 6, settings: this.settings, jobs: this.jobs, activity: this.activity.slice(-50) });
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
		await this.tick();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		const due = dueJobs(this.jobs, Date.now());
		if (!due.length) return;
		this.running = true;
		try {
			for (const job of due) {
				if (this.runningJobs.has(job.id)) continue;
				await this.executeJob(job);
			}
		} finally {
			this.running = false;
		}
	}

	async executeJob(job: Job): Promise<void> {
		if (this.runningJobs.has(job.id)) return;
		this.runningJobs.add(job.id);
		try {
			await this.runJobBody(job);
		} finally {
			this.runningJobs.delete(job.id);
		}
	}

	private async runJobBody(job: Job): Promise<void> {
		job.status = 'running';
		job.lastRunAt = new Date().toISOString();
		job.attempts = Number(job.attempts || 0) + 1;
		job.runCount = Number(job.runCount || 0) + 1;
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
			job.lastReply = reply || '';
			job.lastStatus = 'completed';
			job.lastError = null;
			job.status = 'completed';
			await this.processFollowUps(reply, job);
			if (job.output && job.output.folder && reply) {
				await this.writeOutput(job.output.folder, job.output.filename, reply);
			}
			reconcileAfterRun(job);
			this.logActivity('completed', job.title, job.id);
			if (this.settings.notifyOnCompletion && job.notify !== false) new Notice(`AI completed: ${job.title}`, 5000);
		} catch (error) {
			job.status = 'failed';
			job.lastStatus = 'failed';
			job.lastError = errorText(error);
			reconcileAfterRun(job, { failed: true });
			this.lastTickError = job.lastError;
			this.logActivity('failed', `${job.title}: ${job.lastError}`, job.id);
			new Notice(`AI task failed: ${job.title}\n${job.lastError}`, 8000);
		}
		await this.saveState();
	}

	async handleVaultChange(file: { path?: string }): Promise<void> {
		if (!file || !file.path || this.running) return;
		const eventJobs = this.jobs.filter(job => job.enabled && job.schedule && job.schedule.kind === 'event'
			&& (!job.schedule.event || job.schedule.event === 'modify' || job.schedule.event === 'vault-change'));
		if (!eventJobs.length) return;
		const now = Date.now();
		for (const job of eventJobs) {
			const cooldown = Number(job.cooldownMinutes || 10) * 60000;
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
			if (!job.nextRunAt || new Date(job.nextRunAt) <= new Date()) job.nextRunAt = nextDailyRun(this.settings.reviewTime);
		}
	}

	async startReviewRun(manual = true, kind: 'daily' | 'nightly' = 'daily'): Promise<void> {
		if (this.reviewRunning) {
			new Notice('A review is already running. You can keep using Obsidian while it finishes.', 5000);
			return;
		}
		this.reviewRunning = true;
		new Notice(`${kind === 'nightly' ? 'Nightly' : 'Daily'} review started. It will create ${this.settings.reportFolder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7000);
		void this.runDailyReview(manual, null, kind).catch(error => {
			this.logActivity('failed', `Review failed: ${errorText(error)}`);
			new Notice(`Review failed: ${errorText(error)}`, 8000);
			void this.saveState();
		}).finally(() => { this.reviewRunning = false; });
	}

	async runDailyReview(manual: boolean, execution: backends.ResolvedExecution | null = null, kind: 'daily' | 'nightly' = 'daily'): Promise<string> {
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
		this.logActivity('review', `Daily review written to ${path}`);
		if (manual || this.settings.notifyOnCompletion) new Notice(`Review written to ${path}`, 6000);
		await this.saveState();
		return report;
	}

	includeReviewFile(file: { path: string; stat: { mtime: number } }, start: Date): boolean {
		if (!file || !file.path || file.path.startsWith(`${this.settings.reportFolder}/`)) return false;
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

	getJobContext(job: Job): JobContext {
		const context = getPathsContext(this.app, job && job.contextPaths);
		if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(', ')}`);
		return context;
	}

	async writeOutput(folder: string, filename: string | undefined, content: string): Promise<string> {
		const cleanFolder = normalizePath(String(folder || '').replace(/^\/+|\/+$/g, ''));
		const cleanName = String(filename || `${localDateKey()}.md`).replace(/[\\/]/g, '-');
		const path = normalizePath(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
		await this.ensureFolder(cleanFolder);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
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
		const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
		for (const plan of plans.slice(0, 3)) {
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
		return {
			title: String(plan.title).slice(0, 120),
			prompt: String(plan.prompt),
			tab: Number(planRecord.tab || fallbackTab || this.settings.assistantTab),
			profile: planRecord.profile || null,
			conversationId: planRecord.conversationId || null,
			providerId: planRecord.providerId || null,
			model: planRecord.model || null,
			schedule: normalized,
			nextRunAt: normalized.kind === 'event' ? null : getScheduleNextRun(normalized),
			output: planRecord.output || null,
			notify: planRecord.notify !== false,
			contextPaths: Array.isArray(planRecord.contextPaths) ? planRecord.contextPaths : Array.isArray(context?.paths) ? context.paths : [],
			cooldownMinutes: planRecord.cooldownMinutes || (schedule.cooldownMinutes as number | undefined),
			source,
		};
	}

	async planAndCreate(goal: string, contextPaths: string[] = [], resultFolder = ''): Promise<{ reply: string; jobs: Job[] }> {
		const execution = await backends.resolveModel(this, this.settings.planningModel, 'AI planning');
		const prompt = plannerPrompt(goal, contextPaths);
		const context = getPathsContext(this.app, contextPaths);
		const reply = await backends.sendToAI(this, prompt, execution, context);
		const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
		if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
		const jobs: Job[] = [];
		for (const plan of plans.slice(0, 10)) {
			const planRecord = plan as { contextPaths?: string[]; context?: { paths?: string[] }; output?: JobOutput | null };
			jobs.push(await this.addJob(Object.assign(
				this.jobFromPlan(Object.assign({}, plan, {
					contextPaths: planRecord.contextPaths || (planRecord.context && planRecord.context.paths) || contextPaths,
					output: planRecord.output || (resultFolder ? { folder: resultFolder } : null),
				}), execution.tab as number, 'planner'),
				{ profile: execution.modelRef, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model },
			)));
		}
		this.logActivity('planned', `AI created ${jobs.length} job(s)`);
		await this.saveState();
		return { reply, jobs };
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

	async resolveModel(value: string | null | undefined, action?: string) {
		return backends.resolveModel(this, value, action);
	}

	testNotification(): void {
		new Notice('AI Scheduler notifications are working.');
		this.logActivity('notification', 'Test notification sent');
		void this.saveState();
	}

	async deleteJob(job: Job): Promise<void> {
		this.jobs = this.jobs.filter(candidate => candidate.id !== job.id);
		this.logActivity('deleted', `Deleted ${job.title}`, job.id);
		await this.saveState();
	}

	async disableAllJobs(): Promise<void> {
		for (const job of this.jobs.filter(candidate => !isNightlyReviewJob(candidate) && candidate.enabled)) {
			job.enabled = false;
			job.nextRunAt = null;
			job.status = 'disabled';
			job.lastStatus = 'disabled';
		}
		await this.saveState();
	}

	async enableJob(job: Job): Promise<void> {
		job.enabled = true;
		job.status = 'scheduled';
		job.lastStatus = null;
		job.lastError = null;
		rescheduleEnabledJob(job);
		await this.saveState();
	}

	async enableAllJobs(): Promise<void> {
		for (const job of this.jobs.filter(candidate => !isNightlyReviewJob(candidate) && isDisabledTask(candidate))) {
			job.enabled = true;
			job.status = 'scheduled';
			job.lastStatus = null;
			job.lastError = null;
			rescheduleEnabledJob(job);
		}
		await this.saveState();
	}

	async deleteAllJobs(): Promise<void> {
		this.jobs = this.jobs.filter(job => isNightlyReviewJob(job));
		this.logActivity('deleted', 'Deleted all scheduled tasks');
		await this.saveState();
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
}
