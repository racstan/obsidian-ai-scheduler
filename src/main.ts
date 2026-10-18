/*
 * AI Scheduler - an autonomy layer for Claudian and Copilot.
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
import { Platform, Notice, Plugin, TFile, moment, normalizePath } from 'obsidian';
import { ActivityEntry, AISettings, BACKEND_INFO, Job, JobOutput, ScheduleKind, TaskSchedule } from './types';
import { DEFAULT_SETTINGS, normalizeJob, parseStoredData } from './settings';
import {
	getScheduleNextRun,
	normalizeMaxIterations,
	setTaskTitleLookup,
	validClock,
	waitsForTrigger,
} from './schedule';
import {
	planStartupCatchUp,
	dueJobs,
	reconcileAfterRun,
	recoverInterruptedRuns,
	rescheduleEnabledJob,
	skipMissedJob,
	filesChangedSince,
	planRetry,
	recordRun,
	chainedJobs,
	createsChainLoop,
	startBlockReason,
	quietHoursEnd,
} from './engine';
import { exportTasks, importTasks } from './transfer';
import { TemplateModal } from './ui/TemplateModal';
import { ImportTasksModal } from './ui/ImportTasksModal';
import { DateFormatter, VariableContext, changedSince, expandVariables } from './variables';
import { DailyNoteSettings, appendBlock, dailyNotePath, insertBlock, outputMode } from './output';
import { executionPrompt, plannerPrompt, refinePrompt, reviewPrompt } from './prompts';
import { getPathsContext, getVaultContextOptions, JobContext } from './context';
import * as backends from './backends';
import { extractJson, errorText, formatDate, formatDuration, isDisabledTask, isNightlyReviewJob, localDateKey, localTimestampKey, logActivityEntry, outputTitle, sendSystemNotification, sleep, validateJobSchema, buildTaskLogRow, TASK_LOG_HEADER } from './util';
import { AssistantModal } from './ui/AssistantModal';
import { PlannerModal } from './ui/PlannerModal';
import { CalendarModal } from './ui/CalendarModal';
import { AssistantSettingTab } from './ui/SettingsTab';
import { ChangelogModal } from './ui/ChangelogModal';
import { closeExistingSchedulerModals } from './ui/dom';
import { ApprovalModal } from './ui/ApprovalModal';
import { APPROVAL_INSTRUCTION, MAX_PENDING, PENDING_KIND_LABELS, PendingChange, editTargetPath, extractEdits } from './approval';
import { TASKS_INSTRUCTION, expandDataviewQueries, fillTemplate, formatAsTasks, runTemplater } from './integrations';
import { ScheduleNotesSync } from './notes';
import { buildIcs } from './ics';
import { GETTING_STARTED_PATH, gettingStartedNote } from './gettingStarted';
import { AIDraft, normalizeDrafts, sameDraft } from './drafts';
import { PastTimePlanError, isPastOncePlan, movePlanToFuture, replyExcerpt } from './planCheck';
import { CalendarHub } from './calendars';

const TICK_MS = 15000;

export { AISchedulerPlugin as default };

export class AISchedulerPlugin extends Plugin {
	settings: AISettings = DEFAULT_SETTINGS;
	jobs: Job[] = [];
	deletedJobs: Job[] = [];
	/**
	 * Whether this device starts scheduled tasks. Kept on the device, not in the
	 * synced plugin data, so a vault shared between devices runs each task once.
	 * Phones and tablets default to no.
	 */
	get runsTasksHere(): boolean {
		const stored = this.loadDeviceSetting('run-tasks-here');
		return typeof stored === 'boolean' ? stored : !Platform.isMobile;
	}

	setRunsTasksHere(value: boolean): void {
		this.saveDeviceSetting('run-tasks-here', value);
		this.updateStatusBar();
	}

	loadDeviceSetting(key: string): unknown {
		const app = this.app as unknown as { loadLocalStorage?: (key: string) => unknown };
		if (typeof app.loadLocalStorage === 'function') return app.loadLocalStorage(`ai-scheduler-${key}`);
		try {
			const raw = window.localStorage.getItem(`ai-scheduler-${this.app.vault.getName()}-${key}`);
			return raw === null ? null : JSON.parse(raw);
		} catch {
			return null;
		}
	}

	saveDeviceSetting(key: string, value: unknown): void {
		const app = this.app as unknown as { saveLocalStorage?: (key: string, value: unknown) => void };
		if (typeof app.saveLocalStorage === 'function') {
			app.saveLocalStorage(`ai-scheduler-${key}`, value);
			return;
		}
		try {
			window.localStorage.setItem(`ai-scheduler-${this.app.vault.getName()}-${key}`, JSON.stringify(value));
		} catch {
			// Storage unavailable: the default applies.
		}
	}

	/** Approval mode: changes to existing notes waiting for the user. */
	pendingChanges: PendingChange[] = [];
	/** Approval-mode runs in progress collect the notes changed meanwhile (not by the plugin). */
	private runWatches = new Set<Set<string>>();
	activity: ActivityEntry[] = [];
	running = false;
	reviewRunning = false;
	lastTickError: string | null = null;
	notesSync: ScheduleNotesSync = new ScheduleNotesSync(this);
	/** Calendar add-ons (beta): calendar links, Google and Outlook. */
	calendars: CalendarHub = new CalendarHub(this);
	private meetingSignature = '';
	pendingVaultEvents: string[] = [];
	private lastTickAt = Date.now();
	private unloaded = false;
	/** False until the startup catch-up rules have been applied; until then only "Run now" tasks start. */
	private startupDone = false;
	private icsTimer: number | null = null;
	private lastIcsExportAt = 0;
	/** Each job's current run: aborting it stops the backend, and a reply arriving after a reset is ignored. */
	private activeRuns = new Map<string, AbortController>();
	runningJobs = new Set<string>();
	isPlanning = false;
	activePlanningGoal: string | null = null;
	private selfWrites = new Set<string>();
	/** Tasks started with "Run now": they run even while paused or in quiet hours. */
	private manualRuns = new Set<string>();
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
		const freshInstall = !data;
		const parsed = parseStoredData(data);
		this.settings = parsed.settings;
		this.jobs = parsed.jobs;
		this.deletedJobs = parsed.deletedJobs;
		this.activity = parsed.activity;
		this.pendingChanges = parsed.pendingChanges;
		// A "running" task may be running on another device that shares this vault.
		if (this.runsTasksHere) recoverInterruptedRuns(this.jobs);
		setTaskTitleLookup(id => this.jobs.find(job => job.id === id)?.title);

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
			id: 'open-getting-started',
			name: 'Open getting started guide',
			callback: () => {
				void this.openGettingStarted().catch(error => new Notice(`Could not open the guide: ${errorText(error)}`, 8000));
			},
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
		this.addCommand({
			id: 'pause-all',
			name: 'Pause all tasks',
			callback: async () => {
				await this.pauseAll(null);
				new Notice('AI Scheduler paused. No task starts on its own until you resume.');
			},
		});
		this.addCommand({
			id: 'resume-all',
			name: 'Resume all tasks',
			callback: async () => {
				if (!this.settings.paused) {
					new Notice('AI Scheduler is not paused.');
					return;
				}
				await this.resumeAll();
				new Notice('AI Scheduler resumed.');
			},
		});
		this.addCommand({
			id: 'new-task-from-template',
			name: 'New task from a template',
			callback: () => new TemplateModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'review-pending-changes',
			name: 'Review changes awaiting approval',
			callback: () => {
				if (!this.pendingChanges.length) {
					new Notice('No changes are waiting for approval.');
					return;
				}
				new ApprovalModal(this.app, this, this.pendingChanges[0]).open();
			},
		});
		this.addCommand({
			id: 'export-tasks',
			name: 'Export tasks to a file',
			callback: () => {
				void this.exportTasksFile()
					.then(path => new Notice(`Tasks exported to ${path}.`, 8000))
					.catch(error => new Notice(`Could not export tasks: ${errorText(error)}`, 8000));
			},
		});
		this.addCommand({
			id: 'import-tasks',
			name: 'Import tasks from a file',
			callback: () => new ImportTasksModal(this.app, this).open(),
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
				// First install only: show the setup guide once. Existing users can open it
				// from the command or settings.
				if (freshInstall && !this.settings.gettingStartedShown) {
					this.settings.gettingStartedShown = true;
					await this.saveState();
					// A problem showing the guide must not stop the startup steps below.
					await this.openGettingStarted().catch(error => console.warn('[ai-scheduler] Could not open the getting started guide:', errorText(error)));
				}
				if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
				await this.catchUpOnStart();
			})().catch(error => console.error('[ai-scheduler] Startup tasks failed:', error))
				.finally(() => { this.startupDone = true; });
		});
	}

	/** Opens the getting-started note in a new tab, creating it first if it doesn't exist. */
	async openGettingStarted(): Promise<void> {
		let file = this.app.vault.getAbstractFileByPath(GETTING_STARTED_PATH);
		if (!(file instanceof TFile)) {
			this.markSelfWrite(GETTING_STARTED_PATH);
			file = await this.app.vault.create(GETTING_STARTED_PATH, gettingStartedNote());
		}
		if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
	}

	onunload(): void {
		if (this.statusBarTimer !== null) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		this.statusBarEl?.remove();
		this.statusBarEl = null;
		this.notesSync?.dispose();
		this.calendars?.dispose();
		if (this.icsTimer !== null) window.clearTimeout(this.icsTimer);
		this.icsTimer = null;
		// Stop runs still in flight: a reloaded/updated instance recovers them, so
		// letting them finish here could run a task twice. Saving is off too, or an
		// old instance could overwrite the new one's data.json.
		for (const run of this.activeRuns.values()) run.abort();
		this.activeRuns.clear();
		// An open dashboard or calendar keeps polling this instance; close it.
		closeExistingSchedulerModals();
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
				pendingChanges: this.pendingChanges.slice(0, MAX_PENDING),
			});
		} catch (error) {
			console.error('[ai-scheduler] Failed to save state:', error);
		}
		this.notesSync.requestSync();
		this.requestIcsExport();
		this.calendars.requestSync();
		// A "before calendar events" task was added or changed: read events on the next tick.
		const meetings = JSON.stringify(this.jobs.filter(job => job.schedule.kind === 'meeting').map(job => [job.id, job.enabled, job.schedule]));
		if (meetings !== this.meetingSignature) {
			this.meetingSignature = meetings;
			this.calendars.pollSoon();
		}
		this.updateStatusBar();
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
			await this.app.vault.process(existing, () => content);
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
		// Another device runs the tasks: leave missed runs for it to sort out.
		if (!this.runsTasksHere) {
			this.startupDone = true;
			return;
		}
		const now = Date.now();
		const plan = planStartupCatchUp(this.jobs, this.settings, now);
		for (const job of plan.stale) skipMissedJob(job);
		// Missed runs are sorted out: scheduled tasks may start from now on.
		this.startupDone = true;
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
		if (this.settings.icsExportEnabled && this.runsTasksHere && nowMs - this.lastIcsExportAt > 3600000) this.requestIcsExport();
		// A long gap between ticks means the computer slept with Obsidian open.
		// Jobs that fell due during the gap follow the same catch-up policy as a
		// restart instead of all firing at once on wake.
		if (nowMs - previousTick > TICK_MS * 8 && this.runsTasksHere) {
			const dueDuringGap = this.jobs.filter(job => job.nextRunAt && new Date(job.nextRunAt).getTime() < previousTick);
			const plan = planStartupCatchUp(dueDuringGap, this.settings, nowMs);
			if (plan.stale.length) {
				for (const job of plan.stale) skipMissedJob(job);
				this.logActivity('startup', `Skipped ${plan.stale.length} task(s) missed while the computer was asleep`);
				await this.saveState();
			}
		}
		if (this.runsTasksHere && this.startupDone) {
			// "Before calendar events" tasks: when each runs next. Not awaited, so a
			// slow connection never holds up other tasks; changes apply next tick.
			const busy = (job: Job) => this.runningJobs.has(job.id) || this.manualRuns.has(job.id);
			void this.calendars.pollMeetings(busy).then(changed => changed ? this.saveState() : undefined);
			// Never prepare for a meeting that already started (e.g. after sleep or a restart).
			for (const job of this.jobs) {
				if (job.schedule.kind === 'meeting' && job.nextRunAt && job.triggerEvent && !busy(job)
					&& new Date(job.triggerEvent.start).getTime() <= nowMs) job.nextRunAt = null;
			}
			this.calendars.syncIfStale();
		}
		if (this.settings.paused && this.settings.pausedUntil && new Date(this.settings.pausedUntil).getTime() <= nowMs) {
			await this.resumeAll(true);
		}
		this.updateStatusBar();
		if (this.running) return;
		// While paused or in quiet hours only "Run now" tasks start; the rest stay due.
		const blocked = startBlockReason(this.settings, new Date());
		// Before the startup catch-up rules ran, a stale missed task must not slip through.
		const due = dueJobs(this.jobs, Date.now())
			.filter(job => this.manualRuns.has(job.id) || (this.startupDone && !blocked && this.runsTasksHere));
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
				this.manualRuns.delete(job.id);
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
		const isReview = job.routine === 'daily-review' || job.routine === 'periodic-review';
		const previousRunAt = job.lastRunAt;
		const lastRun = this.lastSuccessDate(job);
		const retryNumber = Number(job.retryCount || 0);
		const startedAt = new Date();

		if (!isReview && job.onlyIfChanged && lastRun && !this.notesChangedSince(lastRun.getTime(), job.contextPaths || []).length) {
			const reason = job.contextPaths?.length ? 'No attached note changed since the last run.' : 'No note changed since the last run.';
			recordRun(job, { at: startedAt.toISOString(), status: 'skipped', error: reason });
			reconcileAfterRun(job);
			job.status = job.enabled ? 'scheduled' : 'completed';
			job.retryCount = 0;
			this.logActivity('skipped', `Task #${job.taskNumber} skipped: ${job.title} (nothing changed)`, job.id);
			await this.saveState();
			return;
		}

		const run = new AbortController();
		this.activeRuns.set(job.id, run);
		const cancelled = () => this.activeRuns.get(job.id) !== run;
		const timeoutMinutes = Number(job.timeoutMinutes || 0);
		let timedOut = false;
		const timer = timeoutMinutes > 0
			? window.setTimeout(() => { timedOut = true; run.abort(); }, timeoutMinutes * 60000)
			: null;
		job.status = 'running';
		const outputBeforeRun = job.lastOutputPath;
		const appendedBeforeRun = job.lastOutputAppended;
		job.lastOutputPath = null;
		job.lastOutputAppended = undefined;
		job.lastRunAt = startedAt.toISOString();
		job.attempts = Number(job.attempts || 0) + 1;
		this.calendars.markFired(job);
		const restoreOutput = () => {
			if (job.lastOutputPath) return;
			job.lastOutputPath = outputBeforeRun;
			job.lastOutputAppended = appendedBeforeRun;
		};
		this.logActivity('running', `Task #${job.taskNumber} ${retryNumber ? `retry ${retryNumber}` : 'started'}: ${job.title}`, job.id);
		if (job.notify !== false) {
			new Notice(`AI Scheduler: Task #${job.taskNumber} started (${job.title})...`, 4000);
		}
		this.updateStatusBar();
		await this.saveState();
		const variables = this.variablesFor(job, startedAt, lastRun);
		const watched = this.settings.approvalMode && !isReview ? new Set<string>() : null;
		const pendingBefore = this.pendingChanges.length;
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
			const instructions = await this.taskInstructions(job, variables);
			const prompt = isReview
				? ''
				// Follow-ups may not propose further follow-ups, which caps the chain at one level.
				: executionPrompt(
					job.schedule.kind === 'event' && job.lastEventPath
						? `${instructions}\n\nThis run was triggered by a change to: ${job.lastEventPath}`
						: [instructions, this.calendars.eventContext(job)].filter(Boolean).join('\n\n'),
					context.paths,
					job.source !== 'self-talk',
				);
			if (watched) this.runWatches.add(watched);
			const reply = isReview
				? await this.runDailyReview(false, execution, 'periodic', previousRunAt, run.signal)
				: await backends.sendToAI(this, prompt, execution, context, run.signal);
			if (watched) this.runWatches.delete(watched);
			// Reset by the user while waiting: don't record, write or follow up.
			if (cancelled()) return;
			if (timedOut) throw new Error(`Timed out after ${timeoutMinutes} minute(s).`);
			const trimmedReply = (reply || '').trim();
			if (!trimmedReply) {
				throw new Error('The AI returned an empty response.');
			}
			job.lastReply = reply || '';
			job.lastStatus = 'completed';
			job.lastError = null;
			job.status = 'completed';
			// Reviews write their own report in runDailyReview.
			if (!isReview) {
				// Approval mode: edits the AI proposes wait for approval; the rest is the result.
				const { edits, rest } = this.settings.approvalMode ? extractEdits(reply) : { edits: [], rest: reply };
				for (const proposed of edits) this.stageEdit(job, proposed.path, proposed.content);
				const result = rest || (edits.length ? `The AI proposed ${edits.length} change(s) to existing notes; they are waiting for your approval.` : reply);
				await this.saveRunOutput(job, result, variables);
			}
			// Counted only once the output is saved: a failed save is a failed run.
			job.runCount = Number(job.runCount || 0) + 1;
			job.retryCount = 0;
			job.lastSuccessAt = new Date().toISOString();
			// After the output is safely written; follow-up problems are logged, not fatal.
			if (!isReview && job.source !== 'self-talk') await this.processFollowUps(reply, job);
			reconcileAfterRun(job);
			this.queueChainedJobs(job);
			this.logActivity('completed', `Task #${job.taskNumber} finished: ${job.title}`, job.id);
			// Log only what this run wrote, not the job's whole output history.
			// (lastOutputPath was cleared at the start of the run.)
			const runOutputs = job.lastOutputPath ? [job.lastOutputPath] : [];
			const pendingCount = this.pendingChanges.length - pendingBefore;
			const changedDirectly = watched ? [...watched].slice(0, 20) : [];
			if (pendingCount > 0) {
				new Notice(`${job.title}: ${pendingCount} change${pendingCount === 1 ? ' is' : 's are'} waiting for your approval.`, 8000);
				this.logActivity('approval', `Task #${job.taskNumber}: ${pendingCount} change(s) waiting for approval`, job.id);
			}
			if (changedDirectly.length) {
				// The backend's own tools can still edit notes; say so instead of hiding it.
				this.logActivity('approval', `Task #${job.taskNumber}: notes changed directly while it ran: ${changedDirectly.join(', ')}`, job.id);
				new Notice(`${job.title}: ${changedDirectly.length} note(s) changed directly while it ran, not through approval. See the run history.`, 9000);
			}
			recordRun(job, {
				...(pendingCount > 0 ? { pending: pendingCount } : {}),
				...(changedDirectly.length ? { changed: changedDirectly } : {}),
				at: startedAt.toISOString(),
				status: 'completed',
				durationMs: Date.now() - startedAt.getTime(),
				...(runOutputs.length ? { output: runOutputs[0] } : {}),
				...(retryNumber ? { retry: retryNumber } : {}),
			});
			restoreOutput();
			await this.appendTaskLogRow(job, 'completed', runOutputs);
			if (this.settings.notifyOnCompletion && job.notify !== false) {
				new Notice(`AI completed: ${job.title}`, 5000);
			}
			if (this.settings.systemNotifications && job.notify !== false) {
				sendSystemNotification('AI Scheduler', `AI completed: ${job.title}`);
			}
		} catch (error) {
			restoreOutput();
			if (cancelled()) return; // already marked cancelled by resetRunningJob
			job.status = 'failed';
			job.lastStatus = 'failed';
			job.lastError = timedOut ? `Timed out after ${timeoutMinutes} minute(s).` : errorText(error);
			recordRun(job, {
				at: startedAt.toISOString(),
				status: 'failed',
				durationMs: Date.now() - startedAt.getTime(),
				error: job.lastError,
				...(retryNumber ? { retry: retryNumber } : {}),
			});
			const retry = planRetry(job, Date.now());
			if (!retry) reconcileAfterRun(job, { failed: true });
			this.lastTickError = job.lastError;
			this.logActivity('failed', `Task #${job.taskNumber} failed: ${job.title} (${job.lastError})`, job.id);
			await this.appendTaskLogRow(job, 'failed', []);
			if (retry) {
				const when = job.nextRunAt ? formatDate(job.nextRunAt) : 'soon';
				this.logActivity('retrying', `Task #${job.taskNumber} will retry at ${when} (retry ${retry} of ${job.retries})`, job.id);
				new Notice(`AI task failed: ${job.title}\n${job.lastError}\nRetrying at ${when} (retry ${retry} of ${job.retries}).`, 8000);
			} else {
				new Notice(`AI task failed: ${job.title}\n${job.lastError}`, 8000);
				if (this.settings.systemNotifications) {
					sendSystemNotification('AI Scheduler', `AI task failed: ${job.title}`);
				}
			}
		} finally {
			if (watched) this.runWatches.delete(watched);
			if (timer !== null) window.clearTimeout(timer);
			if (this.activeRuns.get(job.id) === run) this.activeRuns.delete(job.id);
		}
		await this.saveState();
	}

	/** Values for {{variables}} in a run's instructions, file name and heading. */
	variablesFor(job: Job, now: Date, lastRun: Date | null): VariableContext {
		return {
			now,
			format: this.formatDate,
			taskTitle: job.title,
			lastRun,
			dailyNotePath: () => this.dailyNotePathFor(now),
			changedNotes: () => this.notesChangedSince(changedSince(lastRun, now).getTime(), []),
			previous: () => {
				const previous = job.schedule.kind === 'after' && job.schedule.afterTask
					? this.jobs.find(other => other.id === job.schedule.afterTask)
					: undefined;
				return previous ? { reply: previous.lastReply || '', output: previous.lastOutputPath ?? null } : null;
			},
		};
	}

	/** Start of the task's last successful run, or null. */
	lastSuccessDate(job: Job): Date | null {
		// Tasks saved before lastSuccessAt existed: their last run counts if it succeeded.
		const lastSuccess = job.lastSuccessAt || (job.lastStatus === 'completed' ? job.lastRunAt : null);
		return lastSuccess ? new Date(lastSuccess) : null;
	}

	/** The full prompt a run would send now, with variables filled in. Nothing is sent. */
	async previewPrompt(job: Job): Promise<string> {
		const variables = this.variablesFor(job, new Date(), this.lastSuccessDate(job));
		const context = getPathsContext(this.app, job.contextPaths || []);
		return executionPrompt(await this.taskInstructions(job, variables), context.paths, job.source !== 'self-talk');
	}

	/**
	 * A task's instructions as sent: Dataview queries run, {{variables}} filled
	 * in, plus what its result options ask of the AI (Tasks-plugin task lines,
	 * proposing edits for approval).
	 */
	async taskInstructions(job: Job, variables: VariableContext): Promise<string> {
		const withQueries = await expandDataviewQueries(this.app, job.prompt, job.notePath || '');
		const withEvents = await this.calendars.expandVariables(withQueries, job, variables.now);
		const parts = [expandVariables(withEvents, variables)];
		if (job.output?.tasks) parts.push(TASKS_INSTRUCTION);
		if (this.settings.approvalMode) parts.push(APPROVAL_INSTRUCTION);
		return parts.join('\n\n');
	}

	/** Queues the tasks that run after `finished`, which just completed. */
	queueChainedJobs(finished: Job): void {
		for (const next of chainedJobs(this.jobs, finished)) {
			if (this.runningJobs.has(next.id)) continue;
			// A loop can still come from a note edit or an import; never run one.
			if (createsChainLoop(this.jobs, next.id, finished.id)) {
				this.logActivity('failed', `Task #${next.taskNumber} was not queued: its "runs after" chain loops back to it`, next.id);
				continue;
			}
			next.nextRunAt = new Date(Date.now() + 2000).toISOString();
			next.status = 'scheduled';
			this.logActivity('planned', `Task #${next.taskNumber} queued: runs after #${finished.taskNumber} finished`, next.id);
		}
	}

	/** Refuses an "after" schedule without a task, or one that would form a loop. */
	checkChain(jobId: string, schedule: TaskSchedule): void {
		if (schedule.kind !== 'after') return;
		const target = schedule.afterTask;
		if (!target || !this.jobs.some(other => other.id === target)) {
			throw new Error('Choose the task this one runs after.');
		}
		if (createsChainLoop(this.jobs, jobId, target)) {
			throw new Error('That would make the task wait for itself (a loop of "after" tasks).');
		}
	}

	/** Stops tasks from starting on their own, until `until` or until resumed. */
	async pauseAll(until: Date | null): Promise<void> {
		this.settings.paused = true;
		this.settings.pausedUntil = until ? until.toISOString() : null;
		this.logActivity('status', until ? `Paused all tasks until ${formatDate(this.settings.pausedUntil)}` : 'Paused all tasks');
		await this.saveState();
	}

	/**
	 * Ends a pause. Runs that fell due while paused follow the catch-up
	 * setting, like runs missed while Obsidian was closed.
	 */
	async resumeAll(automatic = false): Promise<void> {
		if (!this.settings.paused) return;
		this.settings.paused = false;
		this.settings.pausedUntil = null;
		const plan = planStartupCatchUp(this.jobs, this.settings, Date.now());
		for (const job of plan.stale) skipMissedJob(job);
		const skipped = plan.stale.length ? ` (skipped ${plan.stale.length} run(s) missed while paused)` : '';
		this.logActivity('status', `${automatic ? 'Pause ended' : 'Resumed all tasks'}${skipped}`);
		await this.saveState();
	}

	/** Writes all tasks to a JSON file in the result folder and returns its path. */
	async exportTasksFile(): Promise<string> {
		const jobs = this.jobs.filter(job => !isNightlyReviewJob(job));
		if (!jobs.length) throw new Error('There are no tasks to export.');
		const folder = this.checkSafeFolder(this.getDefaultOutputFolder());
		await this.ensureFolder(folder);
		const base = `${folder ? `${folder}/` : ''}AI Scheduler tasks ${localDateKey()}`;
		let path = normalizePath(`${base}.json`);
		for (let suffix = 2; this.app.vault.getAbstractFileByPath(path); suffix++) path = normalizePath(`${base}-${suffix}.json`);
		this.markSelfWrite(path);
		await this.app.vault.create(path, exportTasks(jobs));
		return path;
	}

	/** Adds the tasks from an export file, paused. Returns how many were added. */
	async importTasksText(text: string): Promise<number> {
		const imported = importTasks(text, this.jobs);
		this.assignTaskNumbers();
		let number = Math.max(0, ...this.jobs.map(job => Number(job.taskNumber) || 0));
		for (const job of imported) {
			job.taskNumber = ++number;
			this.jobs.push(job);
		}
		this.logActivity('planned', `Imported ${imported.length} task(s), paused for review`);
		await this.saveState();
		return imported.length;
	}

	// Obsidian's bundled moment; its typings describe the namespace, not the callable.
	readonly formatDate: DateFormatter = (date, format) => (moment as unknown as (input: Date) => { format: (pattern: string) => string })(date).format(format);

	/** The Daily notes core plugin's folder, file name format and template. */
	getDailyNoteSettings(): DailyNoteSettings & { template?: string } {
		const internal = (this.app as unknown as {
			internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: DailyNoteSettings & { template?: string } } } | null };
		}).internalPlugins;
		return internal?.getPluginById?.('daily-notes')?.instance?.options ?? {};
	}

	dailyNotePathFor(date: Date): string {
		return normalizePath(dailyNotePath(this.getDailyNoteSettings(), date, this.formatDate));
	}

	/**
	 * Notes changed after `since` (ms), newest first. With `scope` (attached
	 * notes and folders) only those count. Files the plugin wrote itself (task
	 * results, reviews, schedule notes, the log and calendar file) never count.
	 */
	notesChangedSince(since: number, scope: string[]): string[] {
		const exclude = [
			this.getPeriodicReviewFolder(),
			normalizePath(this.settings.scheduleFolder || 'AI Schedules'),
			normalizePath(`${this.getTaskLogFolder()}/AI SCHEDULER LOGS.md`),
			normalizePath(this.settings.icsExportPath || ''),
		];
		for (const job of [...this.jobs, ...this.deletedJobs]) {
			job.lastOutputFiles?.forEach(path => exclude.push(path));
		}
		const files = this.app.vault.getMarkdownFiles().map(file => ({ path: file.path, mtime: file.stat.mtime }));
		return filesChangedSince(files, since, scope.map(path => normalizePath(path)), exclude);
	}

	/** Writes a run's result where the task's output mode says. */
	async saveRunOutput(job: Job, rawReply: string, variables: VariableContext): Promise<void> {
		const mode = outputMode(job.output);
		const folder = job.output?.folder || this.getDefaultOutputFolder();
		const filename = job.output?.filename ? expandVariables(job.output.filename, variables, true).trim() : '';
		const reply = job.output?.tasks ? formatAsTasks(rawReply, job.output.taskTag) : rawReply;
		if (mode === 'append' || mode === 'daily') {
			const heading = job.output?.heading ? expandVariables(job.output.heading, variables).split('\n')[0] : undefined;
			const path = mode === 'daily'
				? this.dailyNotePathFor(variables.now)
				: this.safeNotePath(folder, filename || outputTitle(job.title));
			const stamp = this.formatDate(variables.now, 'YYYY-MM-DD HH:mm');
			const block = appendBlock(job.title, stamp, reply);
			// Approval mode: adding to a note that already exists waits for approval.
			if (this.settings.approvalMode && this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
				this.stageChange(job, { kind: 'append', path, content: block, heading, dailyNote: mode === 'daily' });
				return;
			}
			await this.appendToNote(path, block, heading, mode === 'daily');
			// Not recorded as the plugin's own file: it was the user's note, so a
			// later "replace" must never overwrite it.
			job.lastOutputPath = path;
			job.lastOutputAppended = true;
			return;
		}
		const content = await this.resultNoteContent(job, reply, variables);
		if (mode === 'replace') {
			const name = filename || outputTitle(job.title);
			const target = this.safeNotePath(folder, name);
			// Approval mode: replacing the existing result note waits for approval.
			if (this.settings.approvalMode && this.app.vault.getAbstractFileByPath(target) instanceof TFile && this.isOwnOutput(target)) {
				this.stageChange(job, { kind: 'replace', path: target, content });
				return;
			}
			await this.finishResultNote(job, await this.writeOutput(folder, name, content));
			return;
		}
		// A new note every run: a fixed name gets a number instead of replacing the last one.
		await this.finishResultNote(job, filename
			? await this.writeOutput(folder, filename, content, true)
			: await this.writeOutput(folder, `${localTimestampKey()} ${outputTitle(job.title)}`, content));
	}

	/** A new or replaced result note's text: the reply, or the task's template with the reply in it. */
	private async resultNoteContent(job: Job, reply: string, variables: VariableContext): Promise<string> {
		const templatePath = job.output?.template;
		if (!templatePath) return reply;
		// An exact vault path first, then a link-style name such as "Result template".
		const exact = normalizePath(/\.md$/i.test(templatePath) ? templatePath : `${templatePath}.md`);
		const file = this.app.vault.getAbstractFileByPath(exact)
			?? this.app.metadataCache.getFirstLinkpathDest(templatePath.replace(/\.md$/i, ''), '');
		if (!(file instanceof TFile)) {
			this.logActivity('failed', `Task #${job.taskNumber}: template "${templatePath}" not found; saved the result without it`, job.id);
			return reply;
		}
		const template = expandVariables(await this.app.vault.read(file), variables);
		return fillTemplate(template, reply);
	}

	/** Records a result note and, for a templated task, lets Templater fill in its commands. */
	private async finishResultNote(job: Job, path: string): Promise<void> {
		this.recordOutput(job, path);
		if (!job.output?.template) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		try {
			this.markSelfWrite(path);
			await runTemplater(this.app, file);
		} catch (error) {
			this.logActivity('failed', `Task #${job.taskNumber}: Templater could not process ${path} (${errorText(error)})`, job.id);
		}
	}

	/** True when `path` is a note one of the tasks created (not one it only added to). */
	isOwnOutput(path: string): boolean {
		for (const job of [...this.jobs, ...this.deletedJobs]) {
			if (job.lastOutputPath === path && !job.lastOutputAppended) return true;
			if (job.lastOutputFiles?.includes(path)) return true;
		}
		return false;
	}

	/** Queues a change to an existing note for approval. */
	private stageChange(job: Job, change: Pick<PendingChange, 'kind' | 'path' | 'content' | 'heading' | 'dailyNote'>): void {
		this.pendingChanges = [{
			id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			jobId: job.id,
			taskNumber: job.taskNumber,
			taskTitle: job.title,
			createdAt: new Date().toISOString(),
			...change,
		}, ...this.pendingChanges].slice(0, MAX_PENDING);
		this.updateStatusBar();
	}

	/** An edit the AI proposed: queued when its path is a safe vault path, otherwise logged and dropped. */
	private stageEdit(job: Job, rawPath: string, content: string): void {
		const path = editTargetPath(rawPath);
		if (!path) {
			this.logActivity('failed', `Task #${job.taskNumber}: ignored a proposed edit to "${rawPath}" (not a note path inside the vault)`, job.id);
			return;
		}
		this.stageChange(job, { kind: 'edit', path, content });
	}

	/** Applies an approved change. */
	async approveChange(change: PendingChange): Promise<void> {
		const slash = change.path.lastIndexOf('/');
		const folder = slash >= 0 ? change.path.slice(0, slash) : '';
		this.checkSafeFolder(folder);
		if (change.kind === 'append') {
			await this.appendToNote(change.path, change.content, change.heading, change.dailyNote === true);
		} else {
			const existing = this.app.vault.getAbstractFileByPath(change.path);
			if (existing && !(existing instanceof TFile)) throw new Error(`"${change.path}" is a folder, not a note.`);
			await this.ensureFolder(folder);
			this.markSelfWrite(change.path);
			if (existing instanceof TFile) await this.app.vault.process(existing, () => change.content);
			else await this.app.vault.create(change.path, change.content);
		}
		const job = this.jobs.find(candidate => candidate.id === change.jobId);
		if (job && change.kind !== 'edit') {
			job.lastOutputPath = change.path;
			job.lastOutputAppended = change.kind === 'append';
		}
		this.pendingChanges = this.pendingChanges.filter(candidate => candidate.id !== change.id);
		this.logActivity('approval', `Approved: ${PENDING_KIND_LABELS[change.kind].toLowerCase()} ${change.path} (task #${change.taskNumber})`, change.jobId);
		this.updateStatusBar();
		await this.saveState();
	}

	async rejectChange(change: PendingChange): Promise<void> {
		this.pendingChanges = this.pendingChanges.filter(candidate => candidate.id !== change.id);
		this.logActivity('approval', `Rejected: ${PENDING_KIND_LABELS[change.kind].toLowerCase()} ${change.path} (task #${change.taskNumber})`, change.jobId);
		this.updateStatusBar();
		await this.saveState();
	}

	/**
	 * Adds `block` to the note at `path` (at the end, or under `heading`),
	 * creating the note if needed. A new daily note starts from the Daily notes
	 * template when one is set.
	 */
	async appendToNote(path: string, block: string, heading?: string, isDailyNote = false): Promise<void> {
		const slash = path.lastIndexOf('/');
		const folder = slash >= 0 ? path.slice(0, slash) : '';
		this.checkSafeFolder(folder);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) throw new Error(`"${path}" is a folder, not a note.`);
		await this.ensureFolder(folder);
		this.markSelfWrite(path);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, content => insertBlock(content, block, heading));
			return;
		}
		const initial = isDailyNote ? await this.dailyNoteTemplate(path) : '';
		await this.app.vault.create(path, insertBlock(initial, block, heading));
	}

	/** The Daily notes template with its {{date}}, {{time}} and {{title}} filled in, or ''. */
	private async dailyNoteTemplate(path: string): Promise<string> {
		const template = String(this.getDailyNoteSettings().template || '').trim();
		if (!template) return '';
		const file = this.app.metadataCache.getFirstLinkpathDest(template, '');
		if (!(file instanceof TFile)) return '';
		const title = path.replace(/\.md$/i, '').split('/').pop() || '';
		const raw = await this.app.vault.read(file);
		return expandVariables(raw.replace(/\{\{\s*title\s*\}\}/gi, title), {
			now: new Date(),
			format: this.formatDate,
			taskTitle: '',
			lastRun: null,
		});
	}

	async handleVaultChange(file: { path?: string }): Promise<void> {
		if (!file || !file.path) return;
		const normPath = normalizePath(file.path);
		if (this.selfWrites.has(normPath)) return;
		for (const watch of this.runWatches) watch.add(normPath);
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
		this.checkChain(job.id, job.schedule);
		if (!waitsForTrigger(job.schedule) && !job.nextRunAt) {
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
	 * Output locations can come from AI replies or schedule notes, so a folder
	 * must stay inside the vault and out of hidden/config folders.
	 */
	checkSafeFolder(folder: string): string {
		const cleanFolder = normalizePath(String(folder || '').replace(/^\/+|\/+$/g, ''));
		const segments = cleanFolder === '/' ? [] : cleanFolder.split('/').filter(Boolean);
		const configDir = this.app.vault.configDir;
		if (segments.some(segment => segment === '..' || segment.startsWith('.') || segment.includes(':'))
			|| segments[0] === configDir) {
			throw new Error(`Refusing to write output to unsafe folder "${folder}".`);
		}
		return segments.join('/');
	}

	/** A note path in `folder` named `filename` (made safe; .md added). */
	safeNotePath(folder: string, filename: string | undefined): string {
		const folderPath = this.checkSafeFolder(folder);
		let baseName = String(filename || localDateKey()).replace(/[\\/:]/g, '-').replace(/^\.+/, '').trim();
		baseName = baseName.replace(/\.md$/i, '') || localDateKey();
		return normalizePath(folderPath ? `${folderPath}/${baseName}.md` : `${baseName}.md`);
	}

	/**
	 * Writes task output as a Markdown note. Existing notes the plugin did not
	 * write are never overwritten (a numbered sibling is created instead); with
	 * `neverOverwrite`, the plugin's own notes aren't either.
	 */
	async writeOutput(folder: string, filename: string | undefined, content: string, neverOverwrite = false): Promise<string> {
		const firstPath = this.safeNotePath(folder, filename);
		const folderPath = firstPath.includes('/') ? firstPath.slice(0, firstPath.lastIndexOf('/')) : '';
		const baseName = firstPath.slice(folderPath ? folderPath.length + 1 : 0).replace(/\.md$/i, '');
		const pathFor = (name: string) => normalizePath(folderPath ? `${folderPath}/${name}.md` : `${name}.md`);

		const ownOutputs = new Set<string>();
		if (!neverOverwrite) {
			for (const job of [...this.jobs, ...this.deletedJobs]) {
				// A note a run only added to belongs to the user.
				if (job.lastOutputPath && !job.lastOutputAppended) ownOutputs.add(job.lastOutputPath);
				job.lastOutputFiles?.forEach(path => ownOutputs.add(path));
			}
		}

		let path = firstPath;
		let existing = this.app.vault.getAbstractFileByPath(path);
		for (let suffix = 2; existing && !(existing instanceof TFile && ownOutputs.has(path)); suffix++) {
			path = pathFor(`${baseName}-${suffix}`);
			existing = this.app.vault.getAbstractFileByPath(path);
		}

		await this.ensureFolder(folderPath);
		this.markSelfWrite(path);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
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
		const nextRunAt = waitsForTrigger(normalized) ? null : getScheduleNextRun(normalized);
		if (!waitsForTrigger(normalized) && !nextRunAt) {
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
				.filter((item): item is Record<string, unknown> => Boolean(item))
				.slice(0, 10);
			if (!plans.length) {
				// Show what the AI said instead: it often explains the problem (a vague or impossible time).
				const said = replyExcerpt(reply);
				throw new Error(said
					? `The AI did not return a schedule. It said: "${said}"`
					: 'The AI returned no valid schedule. Ask it for a concrete time or cadence.');
			}
			// "At 12 pm today" asked at 1:30 pm: nothing is created, and the user can move it to the next day.
			const now = new Date();
			const past = plans.filter(plan => isPastOncePlan(plan, now));
			if (past.length === plans.length) {
				const moved = past.map(plan => movePlanToFuture(plan, now));
				throw new PastTimePlanError(
					past.map(plan => (plan.schedule as { at: string }).at),
					moved.map(plan => (plan.schedule as { at: string }).at),
					async () => {
						const created = await this.createPlannedJobs(moved, execution, validatedPaths, resultFolder);
						if (!created.jobs.length) throw new Error(created.skipped[0] || 'The AI returned no valid schedule.');
						await this.saveState();
						return created.jobs;
					},
				);
			}
			const { jobs, skipped } = await this.createPlannedJobs(plans.filter(plan => !past.includes(plan)), execution, validatedPaths, resultFolder);
			if (past.length) skipped.push(`"${String(past[0].title)}" was planned for a time that has already passed`);
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

	/** Adds the planned tasks one by one; a malformed plan is skipped without stopping the others. */
	private async createPlannedJobs(
		plans: Record<string, unknown>[],
		execution: Awaited<ReturnType<typeof backends.resolveModel>>,
		validatedPaths: string[],
		resultFolder: string,
	): Promise<{ jobs: Job[]; skipped: string[] }> {
		const jobs: Job[] = [];
		const skipped: string[] = [];
		for (const plan of plans) {
			// One malformed plan must not abort the others (some may already be added).
			try {
				const planRecord = plan as { contextPaths?: string[]; context?: { paths?: string[] }; output?: JobOutput | null };
				// The AI may only name notes and folders that exist, and the whole vault only if the user attached it.
				const aiPaths = this.validateContextPaths(planRecord.contextPaths || (planRecord.context && planRecord.context.paths) || [])
					.filter(path => path !== '/' || validatedPaths.includes('/'));
				const newJob = await this.addJob(Object.assign(
					this.jobFromPlan(Object.assign({}, plan, {
						contextPaths: aiPaths.length ? aiPaths : validatedPaths,
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
		return { jobs, skipped };
	}

	getDraft(key: string): AIDraft | null {
		return this.settings.drafts[key] || null;
	}

	/** Saves an unsent AI request, or forgets it when `draft` is null. */
	async saveDraft(key: string, draft: Omit<AIDraft, 'savedAt'> | null): Promise<void> {
		if (sameDraft(this.settings.drafts[key], draft)) return;
		const drafts = { ...this.settings.drafts };
		if (draft && draft.text.trim()) drafts[key] = { ...draft, savedAt: new Date().toISOString() };
		else delete drafts[key];
		this.settings.drafts = normalizeDrafts(drafts);
		await this.saveState();
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
		return BACKEND_INFO[mode === 'none' || !mode ? 'claudian' : mode];
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

	/** Opens Obsidian settings on a tab: AI Scheduler's by default, or another plugin's / a core tab by id. */
	openSettingsTab(tabId: string = this.manifest.id): void {
		const appWithSetting = this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } };
		if (appWithSetting.setting && typeof appWithSetting.setting.open === 'function') {
			appWithSetting.setting.open();
			if (typeof appWithSetting.setting.openTabById === 'function') {
				appWithSetting.setting.openTabById(tabId);
			}
		}
	}

	getBackendReadiness(): { ok: boolean; message: string } {
		const mode = this.settings.backendMode;
		if (mode === 'none' || !mode) {
			return { ok: false, message: 'No AI backend selected. Choose Claudian, Oh My Claudian or Copilot in AI Scheduler settings.' };
		}
		if (mode === 'copilot') {
			const copilot = this.getCopilotPlugin();
			if (!copilot) {
				return { ok: false, message: 'Copilot plugin is not installed or enabled.' };
			}
			const check = this.checkCopilotSetup();
			if (!check.ok) {
				return { ok: false, message: check.message };
			}
			return { ok: true, message: 'Copilot is ready.' };
		} else {
			const name = BACKEND_INFO[mode].name;
			const claudian = this.getClaudianPlugin();
			if (!claudian) {
				return { ok: false, message: `${name} plugin is not installed or enabled.` };
			}
			const models = this.getModelOptions();
			if (!models.length) {
				return { ok: false, message: `No ${name} models found. Open ${name} to configure providers and API keys, then refresh models in Settings.` };
			}
			if (!this.settings.planningModel && !this.settings.executionModel) {
				return { ok: false, message: 'No AI model selected for tasks or planning. Please choose a model in AI Scheduler settings.' };
			}
			return { ok: true, message: `${name} is ready.` };
		}
	}

	/** Stops a run in progress (its reply is then discarded) and forgets a pending "Run now". */
	private stopRun(job: Job): void {
		this.activeRuns.get(job.id)?.abort();
		this.activeRuns.delete(job.id);
		this.runningJobs.delete(job.id);
		this.manualRuns.delete(job.id);
	}

	async deleteJob(job: Job): Promise<void> {
		this.stopRun(job);
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
		this.manualRuns.delete(job.id);
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
			// A one-time task whose time has passed would run at once; it stays off
			// (enable it on its own to choose what happens).
			if (job.schedule.kind === 'once' && (!job.schedule.at || new Date(job.schedule.at).getTime() <= Date.now())) continue;
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
			this.stopRun(job);
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
		// Checked before anything changes, so a refused edit leaves the task as it was.
		this.checkChain(job.id, Object.assign({}, job.schedule, changes.schedule || {}));
		this.manualRuns.delete(job.id);
		Object.assign(job, changes);
		job.schedule = Object.assign({}, job.schedule, changes.schedule || {});
		job.schedule.maxIterations = normalizeMaxIterations(job.schedule.maxIterations);
		job.nextRunAt = waitsForTrigger(job.schedule) ? null : getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
		job.lastError = null;
		job.retryCount = 0;
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
			if (!waitsForTrigger(job.schedule) && !job.nextRunAt) {
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
		job.retryCount = 0;
		job.nextRunAt = new Date(Date.now() - 1000).toISOString();
		this.manualRuns.add(job.id);
		await this.saveState();
		await this.tick();
	}

	/**
	 * "Run again" on a past task: it becomes a one-time task that runs now
	 * (`at` null) or at `at`. A task that used to repeat does not restart its
	 * old schedule this way.
	 */
	async rerunJob(job: Job, at: Date | null): Promise<void> {
		if (at && at.getTime() <= Date.now()) throw new Error('That time has already passed.');
		const wasRecurring = job.schedule.kind !== 'once';
		const when = at || new Date();
		job.schedule = { kind: 'once', at: when.toISOString() };
		if (wasRecurring) this.logActivity('edited', `Task #${job.taskNumber} is now a one-time task (run again): ${job.title}`, job.id);
		if (!at) {
			await this.runJobNow(job);
			return;
		}
		this.manualRuns.delete(job.id);
		job.enabled = true;
		job.status = 'scheduled';
		job.lastStatus = null;
		job.lastError = null;
		job.retryCount = 0;
		job.nextRunAt = when.toISOString();
		this.logActivity('scheduled', `Task #${job.taskNumber} will run again at ${formatDate(job.nextRunAt)}: ${job.title}`, job.id);
		await this.saveState();
	}

	async resetRunningJob(job: Job): Promise<void> {
		this.runningJobs.delete(job.id);
		// Stop the backend call; if a reply still arrives it is discarded.
		this.activeRuns.get(job.id)?.abort();
		this.activeRuns.delete(job.id);
		job.status = 'failed';
		job.lastStatus = 'cancelled';
		job.lastError = 'Cancelled or reset by user';
		job.retryCount = 0;
		if (job.lastRunAt) {
			recordRun(job, {
				at: job.lastRunAt,
				status: 'cancelled',
				durationMs: Math.max(0, Date.now() - new Date(job.lastRunAt).getTime()),
				error: job.lastError,
			});
		}
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
			this.pendingChanges.length,
			this.activity[0]?.id,
			this.isPlanning,
			this.reviewRunning,
			// Running timers tick every second.
			running ? Math.floor(Date.now() / 1000) : 0,
		]);
	}

	/** Status bar text when nothing runs: paused, quiet hours, or the next run. */
	private idleStatusText(): { text: string; tooltip: string } | null {
		const now = new Date();
		if (this.pendingChanges.length) {
			const count = this.pendingChanges.length;
			return { text: `AI: ${count} to approve`, tooltip: `${count} change${count === 1 ? '' : 's'} to existing notes waiting for your approval. Click to open the dashboard.` };
		}
		const block = startBlockReason(this.settings, now);
		if (block === 'paused') {
			const until = this.settings.pausedUntil ? ` until ${shortTime(new Date(this.settings.pausedUntil), now)}` : '';
			return { text: `AI Scheduler paused${until}`, tooltip: 'No task starts on its own. Click to open the dashboard and resume.' };
		}
		if (!this.settings.statusBarNextRun) return null;
		if (block === 'quiet') {
			return {
				text: `AI: quiet hours until ${shortTime(quietHoursEnd(now, this.settings.quietEnd), now)}`,
				tooltip: 'Tasks due now wait until the quiet hours end. Click to open the dashboard.',
			};
		}
		const next = this.jobs
			.filter(job => job.enabled && job.nextRunAt)
			.sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];
		if (!next?.nextRunAt) return null;
		return {
			text: `AI: next ${shortTime(new Date(next.nextRunAt), now)}`,
			tooltip: `Next: #${next.taskNumber} ${next.title} at ${formatDate(next.nextRunAt)}. Click to open the dashboard.`,
		};
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
			const idle = this.idleStatusText();
			if (!idle) {
				this.statusBarEl.hide();
				return;
			}
			this.statusBarEl.show();
			this.statusBarEl.createSpan({ cls: 'ai-scheduler-status-bar-text', text: idle.text });
			this.statusBarEl.setAttribute('title', idle.tooltip);
			this.statusBarEl.onclick = () => new AssistantModal(this.app, this).open();
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

/** "14:30" today, "Mon 14:30" within a week, otherwise the date and time. */
function shortTime(date: Date, now: Date): string {
	const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (date.toDateString() === now.toDateString()) return time;
	if (date.getTime() - now.getTime() < 6 * 24 * 60 * 60 * 1000) {
		return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
	}
	return date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}
