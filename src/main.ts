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
import { extractJson, errorText, formatDate, formatDuration, isDisabledTask, isNightlyReviewJob, localDateKey, localTimestampKey, logActivityEntry, outputTitle, sendSystemNotification, sleep, validateJobSchema, buildTaskLogRow, TASK_LOG_HEADER } from './util';
import { AssistantModal } from './ui/AssistantModal';
import { PlannerModal } from './ui/PlannerModal';
import { CalendarModal } from './ui/CalendarModal';
import { AssistantSettingTab } from './ui/SettingsTab';
import { ChangelogModal } from './ui/ChangelogModal';
import { ScheduleNotesSync } from './notes';
import { buildIcs } from './ics';

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
	private lastTickAt = Date.now();
	private unloaded = false;
	private icsTimer: number | null = null;
	private lastIcsExportAt = 0;
	/** Each job's current run: aborting it stops the backend, and a reply arriving after a reset is ignored. */
	private activeRuns = new Map<string, AbortController>();
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
			id: 'open-calendar',
			name: 'Open schedule calendar',
			callback: () => new CalendarModal(this.app, this).open(),
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
			name: 'Run AI periodic review now',
			callback: () => this.startReviewRun(true, 'periodic'),
		});
		this.addCommand({
			id: 'enable-nightly-review',
			name: 'Enable periodic AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = true;
				await this.ensurePeriodicReviewJob();
				await this.saveState();
				new Notice('Periodic AI review enabled');
			},
		});
		this.addCommand({
			id: 'disable-nightly-review',
			name: 'Disable periodic AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = false;
				await this.ensurePeriodicReviewJob();
				await this.saveState();
				new Notice('Periodic AI review disabled');
			},
		});
		this.addCommand({
			id: 'toggle-nightly-review',
			name: 'Toggle periodic AI review',
			callback: async () => {
				this.settings.nightlyReviewEnabled = !this.settings.nightlyReviewEnabled;
				await this.ensurePeriodicReviewJob();
				await this.saveState();
				new Notice(this.settings.nightlyReviewEnabled ? 'Periodic AI review enabled' : 'Periodic AI review disabled');
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
		this.addCommand({
			id: 'export-calendar',
			name: 'Export schedule to calendar file (.ics)',
			callback: () => {
				void this.exportIcs()
					.then(path => new Notice(`Calendar file written to ${path}. Import it into Google Calendar, Outlook or Apple Calendar.`, 8000))
					.catch(error => new Notice(`Could not export calendar: ${errorText(error)}`, 8000));
			},
		});
		this.addSettingTab(new AssistantSettingTab(this.app, this));

		this.registerInterval(window.setInterval(() => { void this.tick(); }, TICK_MS));

		if (this.settings.nightlyReviewEnabled) await this.ensurePeriodicReviewJob();
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

		// Vault listeners wait for the layout: Obsidian fires 'create' for every
		// existing file during the initial vault load. Catch-up runs here too and is
		// not awaited, so a long AI run can't hold up onload (and the backend
		// plugin has had a chance to load).
		this.app.workspace.onLayoutReady(() => {
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
			void (async () => {
				if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
				await this.catchUpOnStart();
			})().catch(error => console.error('[ai-scheduler] Startup tasks failed:', error));
		});
	}

	onunload(): void {
		if (this.statusBarTimer !== null) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		this.statusBarEl?.remove();
		this.statusBarEl = null;
		this.notesSync?.dispose();
		if (this.icsTimer !== null) window.clearTimeout(this.icsTimer);
		this.icsTimer = null;
		// Runs still in flight finish in the background; stop them from saving, or
		// an old instance could overwrite the reloaded/updated plugin's data.json.
		this.unloaded = true;
	}

	async saveState(): Promise<void> {
		if (this.unloaded) return;
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
		this.requestIcsExport();
	}

	/** Refreshes the .ics calendar file shortly after changes (debounced), when enabled. */
	requestIcsExport(): void {
		if (!this.settings.icsExportEnabled || this.unloaded) return;
		if (this.icsTimer !== null) window.clearTimeout(this.icsTimer);
		this.icsTimer = window.setTimeout(() => {
			this.icsTimer = null;
			this.exportIcs().catch(error => console.warn('[ai-scheduler] Calendar export failed:', errorText(error)));
		}, 2000);
	}

	/**
	 * Writes upcoming runs to the configured .ics file and returns its path. The
	 * file is only rewritten when its content changed. Like task output, it must
	 * stay out of hidden/config folders.
	 */
	async exportIcs(): Promise<string> {
		const path = normalizePath(this.settings.icsExportPath.trim() || DEFAULT_SETTINGS.icsExportPath);
		const segments = path.split('/');
		if (!path.toLowerCase().endsWith('.ics')
			|| segments.some(segment => segment === '..' || segment.startsWith('.') || segment.includes(':'))
			|| segments[0] === this.app.vault.configDir) {
			throw new Error(`"${path}" is not a valid calendar file path. Use a vault path ending in .ics, outside hidden folders.`);
		}
		const now = new Date();
		const content = buildIcs(this.jobs, now, new Date(now.getTime() + this.settings.icsExportDays * 86400000));
		this.lastIcsExportAt = Date.now();
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (await this.app.vault.read(existing) === content) return path;
			this.markSelfWrite(path);
			await this.app.vault.modify(existing, content);
		} else if (existing) {
			throw new Error(`"${path}" is a folder.`);
		} else {
			await this.ensureFolder(segments.slice(0, -1).join('/'));
			this.markSelfWrite(path);
			await this.app.vault.create(path, content);
		}
		return path;
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
		const nowMs = Date.now();
		const previousTick = this.lastTickAt;
		this.lastTickAt = nowMs;
		// The exported window moves with time (past runs drop off, new days join).
		if (this.settings.icsExportEnabled && nowMs - this.lastIcsExportAt > 3600000) this.requestIcsExport();
		// A long gap between ticks means the computer slept with Obsidian open.
		// Jobs that fell due during the gap follow the same catch-up policy as a
		// restart instead of all firing at once on wake.
		if (nowMs - previousTick > TICK_MS * 8) {
			const dueDuringGap = this.jobs.filter(job => job.nextRunAt && new Date(job.nextRunAt).getTime() < previousTick);
			const plan = planStartupCatchUp(dueDuringGap, this.settings, nowMs);
			if (plan.stale.length) {
				for (const job of plan.stale) skipMissedJob(job);
				this.logActivity('startup', `Skipped ${plan.stale.length} task(s) missed while the computer was asleep`);
				await this.saveState();
			}
		}
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
				// Earlier jobs can run for minutes; skip any deleted, disabled or
				// rescheduled meanwhile.
				if (!this.jobs.includes(job) || !job.enabled || !job.nextRunAt || new Date(job.nextRunAt).getTime() > Date.now()) continue;
				// A manual review is in progress: leave the scheduled one due for the next tick
				// instead of failing it with "already in progress".
				if (isNightlyReviewJob(job) && this.reviewRunning) continue;
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
		const run = new AbortController();
		this.activeRuns.set(job.id, run);
		const cancelled = () => this.activeRuns.get(job.id) !== run;
		job.status = 'running';
		const previousRunAt = job.lastRunAt;
		const outputBeforeRun = job.lastOutputPath;
		job.lastOutputPath = null;
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
			const isReview = job.routine === 'daily-review' || job.routine === 'periodic-review';
			const prompt = isReview
				? ''
				// Follow-ups may not propose further follow-ups, which caps the chain at one level.
				: executionPrompt(
					job.schedule.kind === 'event' && job.lastEventPath
						? `${job.prompt}\n\nThis run was triggered by a change to: ${job.lastEventPath}`
						: job.prompt,
					context.paths,
					job.source !== 'self-talk',
				);
			const reply = isReview
				? await this.runDailyReview(false, execution, 'periodic', previousRunAt, run.signal)
				: await backends.sendToAI(this, prompt, execution, context, run.signal);
			// Reset by the user while waiting: don't record, write or follow up.
			if (cancelled()) return;
			const trimmedReply = (reply || '').trim();
			if (!trimmedReply) {
				throw new Error('The AI returned an empty response.');
			}
			job.lastReply = reply || '';
			job.lastStatus = 'completed';
			job.lastError = null;
			job.status = 'completed';
			job.runCount = Number(job.runCount || 0) + 1;
			// Reviews write their own report in runDailyReview.
			if (!isReview) {
				const folder = job.output?.folder || this.getDefaultOutputFolder();
				// Without a fixed filename every run gets its own note, so jobs sharing a
				// folder (or a job running several times a day) don't replace each other.
				const filename = job.output?.filename || `${localTimestampKey()} ${outputTitle(job.title)}`;
				this.recordOutput(job, await this.writeOutput(folder, filename, reply));
			}
			// After the output is safely written; follow-up problems are logged, not fatal.
			if (job.source !== 'self-talk') await this.processFollowUps(reply, job);
			reconcileAfterRun(job);
			this.logActivity('completed', `Task #${job.taskNumber} finished: ${job.title}`, job.id);
			// Log only what this run wrote, not the job's whole output history.
			// (lastOutputPath was cleared at the start of the run.)
			const runOutputs = job.lastOutputPath ? [job.lastOutputPath] : [];
			if (!job.lastOutputPath) job.lastOutputPath = outputBeforeRun;
			await this.appendTaskLogRow(job, 'completed', runOutputs);
			if (this.settings.notifyOnCompletion && job.notify !== false) {
				new Notice(`AI completed: ${job.title}`, 5000);
			}
			if (this.settings.systemNotifications && job.notify !== false) {
				sendSystemNotification('AI Scheduler', `AI completed: ${job.title}`);
			}
		} catch (error) {
			if (!job.lastOutputPath) job.lastOutputPath = outputBeforeRun;
			if (cancelled()) return; // already marked cancelled by resetRunningJob
			job.status = 'failed';
			job.lastStatus = 'failed';
			job.lastError = errorText(error);
			reconcileAfterRun(job, { failed: true });
			this.lastTickError = job.lastError;
			this.logActivity('failed', `Task #${job.taskNumber} failed: ${job.title} (${job.lastError})`, job.id);
			await this.appendTaskLogRow(job, 'failed', []);
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
		const normReport = this.getPeriodicReviewFolder();
		const normSchedule = normalizePath(this.settings.scheduleFolder || 'AI Schedules');
		if (ScheduleNotesSync.isInside(normReport, normPath) || ScheduleNotesSync.isInside(normSchedule, normPath)) {
			return;
		}
		if (this.running) {
			// Edits made while an event-triggered job runs are most likely the agent's
			// own; replaying them would let event jobs trigger each other endlessly.
			if (this.jobs.some(job => this.runningJobs.has(job.id) && job.schedule.kind === 'event')) return;
			if (!this.pendingVaultEvents.includes(file.path)) this.pendingVaultEvents.push(file.path);
			return;
		}
		const eventJobs = this.jobs.filter(job => job.enabled && job.schedule && job.schedule.kind === 'event'
			&& (!job.schedule.event || job.schedule.event === 'modify' || job.schedule.event === 'vault-change'));
		if (!eventJobs.length) return;
		const now = Date.now();
		let changed = false;
		for (const job of eventJobs) {
			const minutes = Number(job.cooldownMinutes ?? 10); // 0 is a valid cooldown
			const cooldown = (Number.isFinite(minutes) && minutes >= 0 ? minutes : 10) * 60000;
			if (job.lastRunAt && now - new Date(job.lastRunAt).getTime() < cooldown) continue;
			if (job.nextRunAt) continue; // already queued to run
			job.nextRunAt = new Date(now + 2000).toISOString();
			job.lastEventPath = file.path;
			changed = true;
		}
		// Autosave fires 'modify' every couple of seconds while typing; only persist real changes.
		if (changed) await this.saveState();
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

	getPeriodicReviewFolder(): string {
		if (this.settings.reportFolder && this.settings.reportFolder.trim()) {
			return normalizePath(this.settings.reportFolder.trim());
		}
		return normalizePath(`${this.getDefaultOutputFolder()}/Periodic Reviews`);
	}

	async ensurePeriodicReviewJob(): Promise<void> {
		let job = this.jobs.find(candidate => candidate.routine === 'daily-review' || candidate.routine === 'periodic-review');
		if (!this.settings.nightlyReviewEnabled) {
			if (job) {
				job.enabled = false;
				job.nextRunAt = null;
				job.status = 'disabled';
				job.lastStatus = 'disabled';
			}
			return;
		}

		const cadence = this.settings.periodicReviewCadence || 'daily';
		let schedule: TaskSchedule;

		if (cadence === 'hourly') {
			const hours = Math.max(1, Number(this.settings.periodicReviewHours) || 12);
			schedule = { kind: 'interval', intervalMinutes: hours * 60 };
		} else if (cadence === 'every-n-days') {
			const everyDays = Math.max(1, Number(this.settings.periodicReviewEveryDays) || 2);
			const time = validClock(this.settings.reviewTime) ? this.settings.reviewTime : '22:00';
			// Keep the existing anchor so the N-day cycle isn't restarted on every load.
			schedule = { kind: 'daily', time, everyDays, startAt: job?.schedule.everyDays ? job.schedule.startAt : undefined };
		} else if (cadence === 'weekly') {
			const days = Array.isArray(this.settings.periodicReviewDays) && this.settings.periodicReviewDays.length
				? this.settings.periodicReviewDays
				: [1];
			const time = validClock(this.settings.reviewTime) ? this.settings.reviewTime : '22:00';
			schedule = { kind: 'weekly', time, days };
		} else {
			// daily
			const time = validClock(this.settings.reviewTime) ? this.settings.reviewTime : '22:00';
			schedule = { kind: 'daily', time };
		}

		if (!job) {
			job = normalizeJob({
				id: 'periodic-vault-review',
				title: 'Periodic vault review',
				prompt: '',
				tab: this.settings.assistantTab,
				routine: 'periodic-review',
				schedule,
				notify: true,
			});
			this.jobs.push(job);
		} else {
			// Runs on every load and settings change: only reschedule when the cadence
			// actually changed (or the job was off), otherwise restarts would keep
			// pushing the next review out and an overdue one would never be caught up.
			const canonical = (value: TaskSchedule) => JSON.stringify(normalizeJob({ schedule: value }).schedule);
			const scheduleChanged = canonical(job.schedule) !== canonical(schedule);
			const wasInactive = !job.enabled || !job.nextRunAt;
			job.title = 'Periodic vault review';
			job.routine = 'periodic-review';
			job.tab = this.settings.assistantTab;
			job.schedule = schedule;
			if (scheduleChanged || wasInactive) {
				job.enabled = true;
				job.status = 'scheduled';
				job.lastStatus = null;
				job.nextRunAt = getScheduleNextRun(schedule);
			}
		}
	}

	async ensureNightlyReviewJob(): Promise<void> {
		return this.ensurePeriodicReviewJob();
	}

	async startReviewRun(manual = true, kind: 'daily' | 'nightly' | 'periodic' = 'periodic'): Promise<void> {
		if (this.reviewRunning) {
			new Notice('A review is already running. You can keep using Obsidian while it finishes.', 5000);
			return;
		}
		const folder = this.getPeriodicReviewFolder();
		new Notice(`Periodic review started. It will create ${folder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7000);
		void this.runDailyReview(manual, null, kind).catch(error => {
			this.logActivity('failed', `Review failed: ${errorText(error)}`);
			new Notice(`Review failed: ${errorText(error)}`, 8000);
			void this.saveState();
		});
	}

	async runDailyReview(manual: boolean, execution: backends.ResolvedExecution | null = null, kind: 'daily' | 'nightly' | 'periodic' = 'periodic', since?: string | null, signal?: AbortSignal): Promise<string> {
		if (this.reviewRunning) {
			throw new Error('A review is already in progress.');
		}
		this.reviewRunning = true;
		this.updateStatusBar();
		try {
			const now = new Date();
			const today = localDateKey(now);
			const reviewJob = this.jobs.find(candidate => candidate.routine === 'daily-review' || candidate.routine === 'periodic-review');
			// A periodic review covers everything since the previous review (weekly
			// reviews see the whole week), capped at 31 days; the daily preview and
			// first runs cover today.
			const start = new Date();
			start.setHours(0, 0, 0, 0);
			const previous = kind === 'daily' ? null : new Date(since ?? reviewJob?.lastRunAt ?? '');
			const cap = Date.now() - 31 * 86400000;
			if (previous && !Number.isNaN(previous.getTime()) && previous.getTime() < start.getTime()) {
				start.setTime(Math.max(previous.getTime(), cap));
			}
			const sinceToday = start.getTime() === new Date(now).setHours(0, 0, 0, 0);
			const files = this.app.vault.getMarkdownFiles()
				.filter(file => this.includeReviewFile(file, start))
				.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const fileList = files.length
				? files.map(file => `- ${file.path}`).join('\n')
				: `- No Markdown files were created or modified ${sinceToday ? 'today' : `since ${formatDate(start.toISOString())}`}.`;
			const prompt = reviewPrompt(kind === 'daily' ? 'daily' : 'nightly', today, fileList);
			const model = this.settings.nightlyReviewModel || this.settings.dailyReviewModel;
			const resolved = execution || (reviewJob
				? await backends.resolveJobExecution(this, reviewJob)
				: await backends.resolveModel(this, model, 'periodic review'));
			const context = getPathsContext(this.app, files.map(file => file.path));
			const reply = await backends.sendToAI(this, prompt, resolved, context, signal);
			const reportTitle = kind === 'daily' ? 'Daily Preview' : 'Periodic Vault Review';
			// An empty reply is a failure, not a "completed" review with placeholder text.
			if (!(reply || '').trim()) throw new Error('The AI backend returned an empty review.');
			const report = reply;
			const timestamp = localTimestampKey(now);
			const reportFolder = this.getPeriodicReviewFolder();
			// writeOutput picks a free name if this timestamp is already taken.
			const path = await this.writeOutput(reportFolder, timestamp, `# ${reportTitle} - ${today}\n\nGenerated: ${formatDate(now.toISOString())}\n\n${report}`);
			if (reviewJob) this.recordOutput(reviewJob, path);
			this.logActivity('review', `Periodic review written to ${path}`);
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
		const normReport = this.getPeriodicReviewFolder();
		const normSchedule = normalizePath(this.settings.scheduleFolder || 'AI Schedules');
		// Skip the plugin's own writing (reports, schedule notes, task output and logs).
		const ownFolders = [normReport, normSchedule, normalizePath(this.getDefaultOutputFolder()), normalizePath(this.getTaskLogFolder())];
		if (ownFolders.some(folder => ScheduleNotesSync.isInside(folder, normPath))) {
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

	/** Remembers a file a job wrote, keeping only the most recent 20 in data.json. */
	recordOutput(job: Job, path: string): void {
		job.lastOutputPath = path;
		job.lastOutputFiles = [...(job.lastOutputFiles ?? []).filter(existing => existing !== path), path].slice(-20);
	}

	/**
	 * Writes task output as a Markdown note. Output locations can come from AI
	 * replies or schedule notes, so the folder must stay inside the vault and out
	 * of hidden/config folders, and existing notes the plugin did not write are
	 * never overwritten (a numbered sibling is created instead).
	 */
	async writeOutput(folder: string, filename: string | undefined, content: string): Promise<string> {
		const cleanFolder = normalizePath(String(folder || '').replace(/^\/+|\/+$/g, ''));
		const segments = cleanFolder === '/' ? [] : cleanFolder.split('/').filter(Boolean);
		const configDir = this.app.vault.configDir;
		if (segments.some(segment => segment === '..' || segment.startsWith('.') || segment.includes(':'))
			|| segments[0] === configDir) {
			throw new Error(`Refusing to write output to unsafe folder "${folder}".`);
		}
		const folderPath = segments.join('/');
		let baseName = String(filename || localDateKey()).replace(/[\\/:]/g, '-').replace(/^\.+/, '').trim();
		baseName = baseName.replace(/\.md$/i, '') || localDateKey();
		const pathFor = (name: string) => normalizePath(folderPath ? `${folderPath}/${name}.md` : `${name}.md`);

		const ownOutputs = new Set<string>();
		for (const job of [...this.jobs, ...this.deletedJobs]) {
			if (job.lastOutputPath) ownOutputs.add(job.lastOutputPath);
			job.lastOutputFiles?.forEach(path => ownOutputs.add(path));
		}

		let path = pathFor(baseName);
		let existing = this.app.vault.getAbstractFileByPath(path);
		for (let suffix = 2; existing && !(existing instanceof TFile && ownOutputs.has(path)); suffix++) {
			path = pathFor(`${baseName}-${suffix}`);
			existing = this.app.vault.getAbstractFileByPath(path);
		}

		await this.ensureFolder(folderPath);
		this.markSelfWrite(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
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

	/** Returns the configured default output folder, falling back to 'AI Scheduler'. */
	getDefaultOutputFolder(): string {
		return (this.settings.defaultOutputFolder || '').trim() || 'AI Scheduler';
	}

	/** Returns the configured task log folder, falling back to the default output folder. */
	getTaskLogFolder(): string {
		return (this.settings.taskLogFolder || '').trim() || this.getDefaultOutputFolder();
	}

	/**
	 * Appends a single row to the task activity log Markdown table.
	 * The file is created on first write; subsequent runs append a row.
	 * Silently skips if task logging is disabled.
	 */
	async appendTaskLogRow(job: Job, status: string, outputFiles: string[]): Promise<void> {
		if (!this.settings.taskLoggingEnabled) return;
		try {
			const logFolder = this.getTaskLogFolder();
			const logPath = normalizePath(`${logFolder}/AI SCHEDULER LOGS.md`);
			await this.ensureFolder(logFolder);
			this.markSelfWrite(logPath);
			// The serial number is the count of existing table data rows (not the header or separator).
			const append = (raw: string) => {
				const serial = raw.split('\n').filter(line =>
					line.startsWith('| ') && !line.startsWith('| # ') && !line.startsWith('| ---'),
				).length + 1;
				return `${raw.trimEnd()}\n${buildTaskLogRow(serial, job, status, outputFiles)}`;
			};
			const existing = this.app.vault.getAbstractFileByPath(logPath);
			if (existing instanceof TFile) {
				// vault.process reads and writes atomically, so a concurrent edit of the
				// log (by the user or another run) isn't lost.
				await this.app.vault.process(existing, append);
			} else {
				await this.app.vault.create(logPath, append(TASK_LOG_HEADER));
			}
		} catch (err) {
			console.warn('[ai-scheduler] Could not write to task log:', err);
		}
	}

	async processFollowUps(reply: string, parentJob: Job): Promise<void> {
		const MAX_TOTAL_JOBS = 100;
		const plans = extractJson(reply)
			.map(item => validateJobSchema(item))
			.filter((item): item is Record<string, unknown> => Boolean(item));
		const proposed: Job[] = [];
		for (const plan of plans.slice(0, 3)) {
			if (this.jobs.length >= MAX_TOTAL_JOBS) {
				console.warn('[ai-scheduler] Follow-up skipped: job limit reached');
				break;
			}
			try {
				// AI replies can be steered by vault content (prompt injection), so
				// follow-ups are created disabled for the user to review, and may not
				// choose their own output location.
				proposed.push(await this.addJob(Object.assign(
					this.jobFromPlan(plan, parentJob.tab, 'self-talk'),
					{
						profile: parentJob.profile || null,
						conversationId: parentJob.conversationId || null,
						providerId: parentJob.providerId || null,
						model: parentJob.model || null,
						contextPaths: parentJob.contextPaths || [],
						output: null,
						enabled: false,
						status: 'disabled',
					},
				)));
			} catch (error) {
				console.warn('[ai-scheduler] Follow-up skipped:', errorText(error));
			}
		}
		if (proposed.length) {
			const numbers = proposed.map(job => `#${job.taskNumber}`).join(', ');
			this.logActivity('planned', `Task #${parentJob.taskNumber} proposed follow-up ${proposed.length === 1 ? 'task' : 'tasks'} ${numbers} (disabled until you enable them)`, parentJob.id);
			new Notice(`AI proposed ${proposed.length} follow-up ${proposed.length === 1 ? 'task' : 'tasks'} (${numbers}). Review and enable them in the dashboard.`, 8000);
		}
	}

	jobFromPlan(plan: Record<string, unknown>, fallbackTab: number, source: string): Partial<Job> & Record<string, unknown> {
		const schedule = (plan.schedule || {}) as Record<string, unknown>;
		const normalized: TaskSchedule = {
			kind: (typeof schedule.kind === 'string' && schedule.kind ? schedule.kind : 'once') as ScheduleKind,
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
			// Tell "no answer at all" apart from "an answer without a usable schedule".
			if (!reply.trim()) throw new Error('The AI backend sent no reply. Check the conversation in your AI backend, then try again.');
			const plans = extractJson(reply)
				.map(item => validateJobSchema(item))
				.filter((item): item is Record<string, unknown> => Boolean(item));
			if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
			const jobs: Job[] = [];
			const skipped: string[] = [];
			for (const plan of plans.slice(0, 10)) {
				// One malformed plan must not abort the others (some may already be added).
				try {
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
				} catch (error) {
					skipped.push(errorText(error));
				}
			}
			if (!jobs.length) throw new Error(skipped[0] || 'The AI returned no valid schedule.');
			if (skipped.length) new Notice(`Skipped ${skipped.length} invalid planned ${skipped.length === 1 ? 'task' : 'tasks'}: ${skipped[0]}`, 9000);
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
			new Notice('System desktop notifications are blocked by Windows/Obsidian permissions.', 6000);
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
		this.logActivity('status', `Task #${job.taskNumber} enabled`, job.id);
		await this.saveState();
	}

	async disableJob(job: Job): Promise<void> {
		job.enabled = false;
		job.nextRunAt = null;
		job.status = 'disabled';
		job.lastStatus = 'disabled';
		this.logActivity('status', `Task #${job.taskNumber} disabled`, job.id);
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
		job.lastError = null;
		if (this.jobs.includes(job) && job.status === 'disabled') {
			// Editing a task the user paused keeps it paused.
			job.enabled = false;
			job.nextRunAt = null;
		} else {
			job.enabled = true;
			job.status = 'scheduled';
		}
		if (!this.jobs.includes(job)) {
			// New tasks (e.g. from the calendar) are edited before they are registered.
			if (job.schedule.kind !== 'event' && !job.nextRunAt) {
				throw new Error(`Cannot create "${job.title}": its schedule is invalid or has no valid time.`);
			}
			this.assignTaskNumbers();
			job.taskNumber = Math.max(0, ...this.jobs.map(candidate => Number(candidate.taskNumber) || 0)) + 1;
			job.createdAt = new Date().toISOString();
			this.jobs.push(job);
			this.logActivity('planned', `Task #${job.taskNumber} created: ${job.title}`, job.id);
		}
		await this.saveState();
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
		// Stop the backend call; if a reply still arrives it is discarded.
		this.activeRuns.get(job.id)?.abort();
		this.activeRuns.delete(job.id);
		job.status = 'failed';
		job.lastStatus = 'cancelled';
		job.lastError = 'Cancelled or reset by user';
		reconcileAfterRun(job, { failed: true });
		this.logActivity('cancelled', `Task #${job.taskNumber} cancelled/reset by user: ${job.title}`, job.id);
		this.updateStatusBar();
		await this.saveState();
	}

	/** Changes whenever anything the dashboard/calendar shows changes (drives their live refresh). */
	stateSignature(): string {
		const running = this.runningJobs.size > 0 || this.isPlanning || this.reviewRunning;
		return JSON.stringify([
			this.jobs.map(job => [job.id, job.title, job.status, job.enabled, job.nextRunAt, job.lastRunAt, job.lastStatus, job.runCount, job.taskNumber]),
			this.deletedJobs.length,
			this.activity[0]?.id,
			this.isPlanning,
			this.reviewRunning,
			// Running timers tick every second.
			running ? Math.floor(Date.now() / 1000) : 0,
		]);
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

