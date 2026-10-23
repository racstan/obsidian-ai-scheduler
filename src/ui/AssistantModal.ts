import { App, ItemView, Menu, Modal, Notice, Setting, WorkspaceLeaf } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { formatDate, formatDuration, describeBinding, isDisabledTask, isNightlyReviewJob, summarizeTasks } from '../util';
import { describeSchedule, getScheduleNextRun, waitsForTrigger } from '../schedule';
import { closeExistingSchedulerModals, liveRefresh, makeButton, makeCard, makeClickable, releaseSchedulerModal } from './dom';
import { renderBackendBar } from './backendBar';
import { JobModal } from './JobModal';
import { PlannerModal } from './PlannerModal';
import { TaskViewModal } from './TaskViewModal';
import { CalendarModal } from './CalendarModal';
import { TemplateModal } from './TemplateModal';
import { ImportTasksModal } from './ImportTasksModal';
import { RunAgainModal } from './RunAgainModal';
import { ApprovalModal } from './ApprovalModal';
import { PENDING_KIND_LABELS, PendingChange } from '../approval';
import { Job } from '../types';
import { quietHoursEnd, startBlockReason } from '../engine';
import { errorText } from '../util';
import { SORT_LABELS, TaskSort, sortTasks, taskMatches } from '../taskFilter';
import { listTitles, summarizeNextRun } from '../nextRun';


export class ConfirmModal extends Modal {
	constructor(app: App, public message: string, public onConfirm: () => void) {
		super(app);
	}
	onOpen(): void {
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-confirm-modal');
		this.contentEl.createEl('h3', { text: 'Confirm' });
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => btn.setButtonText('Confirm').setCta().onClick(() => {
				this.onConfirm();
				this.close();
			}));
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

export class PastDuePromptModal extends Modal {
	constructor(
		app: App,
		public plugin: AISchedulerPlugin,
		public job: Job,
		public pastTime: string | undefined,
		public onDone: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-past-due-modal');

		const head = this.contentEl.createEl('h3', { text: 'Scheduled time has passed' });
		head.addClass('ai-scheduler-past-due-title');

		const desc = this.contentEl.createDiv({ cls: 'ai-scheduler-past-due-desc' });
		const timeStr = this.pastTime ? formatDate(this.pastTime) : 'earlier';
		desc.createEl('p', {
			text: `The scheduled run time for task #${this.job.taskNumber} (${this.job.title}) was set for ${timeStr}, which is in the past.`
		});
		desc.createEl('p', {
			text: 'Would you like to execute this task immediately now, or edit the schedule to pick a new date and time?'
		});

		const actions = this.contentEl.createDiv({ cls: 'ai-scheduler-past-due-actions' });
		
		makeButton(actions, 'Run now', () => {
			void (async () => {
				this.close();
				new Notice(`Starting task #${this.job.taskNumber} now...`);
				await this.plugin.runJobNow(this.job);
				this.onDone();
			})();
		}, true);

		makeButton(actions, 'Edit schedule', () => {
			this.close();
			window.setTimeout(() => {
				new JobModal(this.app, this.plugin, this.job, () => {
					this.onDone();
				}).open();
			}, 50);
		});

		makeButton(actions, 'Keep disabled', () => {
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The dashboard window. */
export class AssistantModal extends Modal {
	private dashboard: SchedulerDashboard;
	private refreshTimer: number | null = null;

	constructor(app: AISchedulerPlugin['app'], public plugin: AISchedulerPlugin) {
		super(app);
		// Close first, so the next window isn't hidden behind this one.
		this.dashboard = new SchedulerDashboard(plugin, this.contentEl, then => {
			this.close();
			window.setTimeout(then, 50);
		});
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		this.dashboard.render();
		// Live auto-refresh every 3s so task progress and state transitions update in real time
		const refresh = liveRefresh(this.modalEl, () => this.plugin.stateSignature(), () => this.dashboard.render());
		this.refreshTimer = window.setInterval(refresh, 3000);
	}

	onClose(): void {
		if (this.refreshTimer) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		releaseSchedulerModal(this);
		this.contentEl.empty();
	}
}

export const DASHBOARD_VIEW_TYPE = 'ai-scheduler-dashboard';

/** The dashboard as a panel in a sidebar (or any pane the user drags it to). */
export class SchedulerDashboardView extends ItemView {
	private dashboard: SchedulerDashboard;

	constructor(leaf: WorkspaceLeaf, public plugin: AISchedulerPlugin) {
		super(leaf);
		// The panel stays open; other windows open over the workspace.
		this.dashboard = new SchedulerDashboard(plugin, this.contentEl, then => then());
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'AI Scheduler';
	}

	getIcon(): string {
		return 'brain';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('ai-scheduler-view');
		this.render();
		const refresh = liveRefresh(this.contentEl, () => this.plugin.stateSignature(), () => this.render());
		this.registerInterval(window.setInterval(refresh, 3000));
	}

	render(): void {
		this.dashboard.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}

/** The dashboard's content, shown in the window or the sidebar panel. */
export class SchedulerDashboard {
	// Search, tag filter and sort survive the live re-renders.
	private query = '';
	private tagFilter = '';
	private sort: TaskSort = 'default';

	/**
	 * `leave` runs `then` (which opens another window) after the window
	 * version has closed itself.
	 */
	constructor(public plugin: AISchedulerPlugin, private contentEl: HTMLElement, private leave: (then: () => void) => void) {}

	private get app(): App {
		return this.plugin.app;
	}

	private isJobPastDue(job: Job): { isPastDue: boolean; originalTime?: string } {
		if (waitsForTrigger(job.schedule)) {
			return { isPastDue: false };
		}
		if (job.schedule.kind === 'once') {
			const at = job.schedule.at;
			const timeMs = at ? new Date(at).getTime() : NaN;
			if (!Number.isNaN(timeMs) && timeMs <= Date.now()) {
				return { isPastDue: true, originalTime: at };
			}
			return { isPastDue: false };
		}
		const next = getScheduleNextRun(job.schedule, new Date());
		if (!next) {
			return { isPastDue: true, originalTime: job.nextRunAt || undefined };
		}
		return { isPastDue: false };
	}

	render(): void {
		const { contentEl } = this;
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-lg');
		shell.createEl('h1', { text: 'AI Scheduler' }).addClass('ai-scheduler-title');
		shell.createEl('p', { text: 'Plan work, run reviews, and manage scheduled tasks from one place.' }).addClass('ai-scheduler-subtitle');

		// Filled once the action buttons exist: a ready backend is just a button there.
		const backendSlot = shell.createDiv();
		this.renderPauseBanner(shell);
		this.renderApprovals(shell);

		if (this.plugin.isPlanning) {
			const livePlan = makeCard(shell, 'ai-scheduler-planning-live-card');
			const top = livePlan.createDiv({ cls: 'ai-scheduler-planning-live-head' });
			top.createSpan({ cls: 'ai-scheduler-spinner-tiny' });
			top.createDiv({ cls: 'ai-scheduler-planning-live-title', text: 'AI is generating a scheduled plan in the background...' });
			if (this.plugin.activePlanningGoal) {
				livePlan.createDiv({ cls: 'ai-scheduler-planning-live-goal', text: `Goal: "${this.plugin.activePlanningGoal}"` });
			}
			livePlan.createDiv({ cls: 'ai-scheduler-planning-live-sub', text: 'Tasks and timing will automatically appear here once planning completes.' });
		}

		const actions = shell.createDiv('ai-scheduler-actions');
		makeButton(actions, 'Ask AI to plan', () => {
			this.leave(() => {
				new PlannerModal(this.app, this.plugin).open();
			});
		}, true);
		makeButton(actions, 'Calendar', () => {
			this.leave(() => {
				new CalendarModal(this.app, this.plugin).open();
			});
		});
		makeButton(actions, 'From a template', () => {
			this.leave(() => new TemplateModal(this.app, this.plugin).open());
		});
		const pauseButton = makeButton(actions, this.plugin.settings.paused ? 'Resume' : 'Pause…', () => {
			if (this.plugin.settings.paused) {
				void this.plugin.resumeAll().then(() => this.render());
				return;
			}
			this.showPauseMenu(pauseButton);
		});
		const moreButton = makeButton(actions, 'More…', () => this.showMoreMenu(moreButton));
		renderBackendBar(backendSlot, this.plugin, this.leave, actions);
		makeButton(actions, 'AI Scheduler settings', () => {
			this.leave(() => {
				this.plugin.openSettingsTab();
			});
		});

		const userJobs = this.plugin.jobs.filter(job => !isNightlyReviewJob(job));
		const activeCount = userJobs.filter(job => job.enabled).length;
		// Counted the same way as the "Disabled tasks" and "Past tasks" sections below.
		const pausedCount = summarizeTasks(userJobs.filter(job => isDisabledTask(job))).length;
		const pastCount = summarizeTasks(userJobs.filter(job => !job.enabled && !isDisabledTask(job))).length;

		const stats = shell.createDiv({ cls: 'ai-scheduler-stats' });
		const addStat = (value: string, label: string, title: string) => {
			const card = makeCard(stats, 'ai-scheduler-card-stat');
			card.setAttr('title', title);
			card.createDiv({ cls: 'ai-scheduler-stat-value', text: value });
			card.createDiv({ cls: 'ai-scheduler-stat-label', text: label });
		};
		addStat(String(activeCount), 'Active tasks', 'Enabled tasks that run on their schedule or trigger');
		addStat(String(pausedCount), 'Paused tasks', 'Tasks you disabled; enable them to schedule them again');
		addStat(String(pastCount), 'Past tasks', 'One-time tasks that finished, failed or were missed');
		this.renderNextRunStat(stats);

		if (userJobs.length > 1) {
			const bulkSection = shell.createDiv('ai-scheduler-bulk-section');
			const bulkActions = bulkSection.createDiv('ai-scheduler-bulk-actions');
			makeButton(bulkActions, 'Enable all', () => {
				new ConfirmModal(
					this.app,
					'Enable all paused tasks? They will resume their normal schedules.',
					() => {
						void (async () => {
							const count = await this.plugin.enableAllJobs();
							new Notice(`Enabled ${count} tasks`);
							this.render();
						})();
					}
				).open();
			});
			makeButton(bulkActions, 'Disable all', () => {
				new ConfirmModal(
					this.app,
					'Disable all tasks? No tasks will run until you re-enable them.',
					() => {
						void (async () => {
							const count = await this.plugin.disableAllJobs();
							new Notice(`Disabled ${count} tasks`);
							this.render();
						})();
					}
				).open();
			});
			makeButton(bulkActions, 'Delete all', () => {
				new ConfirmModal(
					this.app,
					`Delete all ${userJobs.length} tasks? They will be moved to Deleted tasks and can be restored.`,
					() => {
						void (async () => {
							const count = await this.plugin.deleteAllJobs();
							new Notice(`Deleted ${count} tasks. You can restore them from Deleted tasks.`);
							this.render();
						})();
					}
				).open();
			}, false, true);
		}

		const lists = shell.createDiv();
		const renderLists = () => {
			lists.empty();
			this.renderTaskSections(lists, userJobs.filter(job => taskMatches(job, this.query, this.tagFilter)));
		};
		if (userJobs.length) this.renderFilterBar(shell, userJobs, renderLists);
		renderLists();

		if (this.plugin.deletedJobs.length > 0) {
			const deletedHeading = this.renderSection(shell, 'Deleted tasks', 'Tasks in trash · Click Restore to recover');
			deletedHeading.createSpan({ cls: 'ai-scheduler-count-badge ai-scheduler-badge-count', text: String(this.plugin.deletedJobs.length) });

			const trashActions = shell.createDiv({ cls: 'ai-scheduler-row-actions' });
			makeButton(trashActions, 'Restore all', () => {
				new ConfirmModal(
					this.app,
					`Restore all ${this.plugin.deletedJobs.length} deleted tasks?`,
					() => {
						void (async () => {
							const count = await this.plugin.restoreAllJobs();
							new Notice(`Restored ${count} tasks.`);
							this.render();
						})();
					}
				).open();
			});
			makeButton(trashActions, 'Empty trash', () => {
				new ConfirmModal(
					this.app,
					`Permanently delete all ${this.plugin.deletedJobs.length} tasks in trash? This cannot be undone.`,
					() => {
						void (async () => {
							const count = await this.plugin.emptyTrash();
							new Notice(`Permanently deleted ${count} tasks.`);
							this.render();
						})();
					}
				).open();
			}, false, true);

			const deletedList = shell.createDiv({ cls: 'ai-scheduler-deleted-tasks-scroll' });
			for (const job of this.plugin.deletedJobs) {
				const card = makeCard(deletedList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
				titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				titleRow.createSpan({ cls: 'ai-scheduler-act-badge ai-scheduler-act-deleted', text: 'Trash' });

				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}` });
				if (job.prompt) {
					const promptSnippet = job.prompt.length > 100 ? `${job.prompt.slice(0, 100)}...` : job.prompt;
					copy.createDiv({ cls: 'ai-scheduler-task-prompt', text: promptSnippet });
				}

				const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });
				makeButton(controls, 'Restore', () => {
					void (async () => {
						await this.plugin.restoreJob(job);
						new Notice(`Restored task #${job.taskNumber}: ${job.title}`);
						this.render();
					})();
				});
				makeButton(controls, 'Delete forever', () => {
					new ConfirmModal(
						this.app,
						`Permanently delete task #${job.taskNumber} (${job.title})? This cannot be undone.`,
						() => {
							void (async () => {
								await this.plugin.permanentlyDeleteJob(job);
								new Notice(`Permanently deleted task #${job.taskNumber}.`);
								this.render();
							})();
						}
					).open();
				}, false, true);
			}
		}

		const activity = this.plugin.activity.slice(-10).reverse();
		const activityHeading = this.renderSection(shell, 'Recent activity', activity.length ? 'All times are local' : 'No activity yet');
		makeButton(activityHeading, 'Clear', async button => {
			button.disabled = true;
			await this.plugin.clearActivity();
			this.render();
		});
		const activityContainer = shell.createDiv('ai-scheduler-activity-scroll-window');
		if (!activity.length) {
			const empty = activityContainer.createDiv('ai-scheduler-activity-empty');
			empty.setText('Reviews, task runs, and notifications will appear here.');
		} else {
			for (const event of activity) {
				const row = activityContainer.createDiv('ai-scheduler-activity-row');
				const left = row.createDiv({ cls: 'ai-scheduler-activity-left' });
				const badge = left.createSpan({ cls: `ai-scheduler-act-badge ai-scheduler-act-${event.type || 'info'}` });
				badge.setText(this.getActivityTypeLabel(event.type));
				left.createSpan({ text: event.message, cls: 'ai-scheduler-activity-msg' });
				if (event.jobId) {
					const viewLink = left.createSpan({ cls: 'ai-scheduler-activity-view', text: 'View' });
					makeClickable(viewLink, 'View task details', (e) => {
						e.stopPropagation();
						const target = this.plugin.jobs.find(j => j.id === event.jobId) || this.plugin.deletedJobs.find(j => j.id === event.jobId);
						if (target) {
							this.leave(() => {
								new TaskViewModal(this.app, this.plugin, target, () => {
									this.plugin.openDashboard();
								}).open();
							});
						} else {
							new Notice(`Task ${event.jobId} is no longer available.`);
						}
					});
				}
				row.createSpan({ text: formatDate(event.at) }).addClass('ai-scheduler-activity-time');
			}
		}
	}

	private sorted(jobs: Job[]): Job[] {
		return this.sort === 'default' ? jobs : sortTasks(jobs, this.sort);
	}

	/** The "Next run" box: what is running, what runs next (possibly several tasks at once) and what holds it back. */
	private renderNextRunStat(stats: HTMLElement): void {
		const userJobs = this.plugin.jobs.filter(job => !isNightlyReviewJob(job));
		const summary = summarizeNextRun(userJobs, this.plugin.runningJobs, this.plugin.settings);
		const card = makeCard(stats, 'ai-scheduler-card-stat', 'ai-scheduler-stat-next');
		if (summary.running.length) card.addClass('ai-scheduler-stat-running');

		const when = summary.nextAt ? (summary.overdue ? 'Due now' : formatDate(summary.nextAt)) : '';
		const value = summary.running.length
			? (summary.running.length === 1 ? 'Running now' : `${summary.running.length} running now`)
			: when || 'None';
		card.createDiv({ cls: 'ai-scheduler-stat-value ai-scheduler-stat-sm', text: value });
		card.createDiv({ cls: 'ai-scheduler-stat-label', text: 'Next run' });

		const detail = (text: string, cls = '') => card.createDiv({ cls: `ai-scheduler-stat-detail ${cls}`.trim(), text });
		const tasks = (jobs: Job[]) => `${jobs.length > 1 ? `${jobs.length} tasks: ` : ''}${listTitles(jobs)}`;
		if (summary.running.length) {
			detail(listTitles(summary.running));
			if (summary.nextAt) detail(`Then ${when === 'Due now' ? 'due now' : when}: ${tasks(summary.next)}`);
		} else if (summary.nextAt) {
			detail(tasks(summary.next));
		} else {
			detail(summary.waitingForTrigger
				? `${summary.waitingForTrigger} task${summary.waitingForTrigger === 1 ? '' : 's'} waiting for a trigger`
				: 'No task is scheduled');
		}
		if (summary.hold) {
			const until = summary.hold.until ? formatDate(summary.hold.until) : '';
			detail(summary.hold.reason === 'paused'
				? (until ? `Paused until ${until}` : 'Paused until you resume')
				: `Waits for quiet hours to end at ${until}`, 'ai-scheduler-stat-hold');
		}

		// The tooltip lists every task when the box only has room for a few.
		const lines = [
			...summary.running.map(job => `Running: ${job.title}`),
			...summary.next.map(job => `${summary.overdue ? 'Due now' : formatDate(job.nextRunAt)}: ${job.title}`),
		];
		if (lines.length) card.setAttr('title', lines.join('\n'));

		// With exactly one task in the box, clicking opens it.
		const only = [...summary.running, ...summary.next];
		if (only.length === 1) {
			const job = only[0];
			card.addClass('ai-scheduler-stat-clickable');
			makeClickable(card, `Open ${job.title}`, () => {
				this.leave(() => {
					new TaskViewModal(this.app, this.plugin, job, () => {
						this.plugin.openDashboard();
					}).open();
				});
			});
		}
	}

	/** The scheduled, disabled and past task lists (already filtered). */
	private renderTaskSections(shell: HTMLElement, userJobs: Job[]): void {
		const enabled = this.sorted(userJobs.filter(job => job.enabled));
		const filtering = !!(this.query.trim() || this.tagFilter);
		const scheduledHeading = this.renderSection(shell, 'Scheduled tasks', enabled.length ? 'Automated runs' : (filtering ? 'No scheduled task matches the search' : 'No tasks scheduled'));
		if (enabled.length) {
			const badge = scheduledHeading.createSpan({ cls: 'ai-scheduler-count-badge', text: String(enabled.length) });
			badge.addClass('ai-scheduler-badge-count');
		}

		for (const job of enabled) {
			const isRunning = job.status === 'running' || this.plugin.runningJobs.has(job.id);
			const card = makeCard(shell, 'ai-scheduler-task-card');
			if (isRunning) {
				card.addClass('ai-scheduler-task-card-running');
			}
			const copy = card.createDiv();
			const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
			const titleText = titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
			if (isRunning) {
				titleText.addClass('ai-scheduler-title-running');
			}
			this.appendTags(titleRow, job);

			copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}` });

			if (isRunning) {
				const runningDiv = copy.createDiv({ cls: 'ai-scheduler-task-running' });
				const progressRow = runningDiv.createDiv({ cls: 'ai-scheduler-running-progress' });
				progressRow.createSpan({ cls: 'ai-scheduler-spinner' });
				const progressText = progressRow.createSpan({ cls: 'ai-scheduler-running-text' });
				const startIso = job.lastRunAt || job.nextRunAt || new Date().toISOString();
				const duration = formatDuration(startIso);
				progressText.setText(`Running in background (${duration})...`);
				const liveHint = runningDiv.createDiv({ cls: 'ai-scheduler-running-hint' });
				liveHint.setText('AI is executing the prompt. Output will be saved when finished.');
			} else {
				const nextText = job.nextRunAt ? `Next run: ${formatDate(job.nextRunAt)}` : (job.schedule.kind === 'event' ? 'Trigger: On vault note modification' : job.schedule.kind === 'after' || job.schedule.kind === 'meeting' ? `Runs ${describeSchedule(job)}` : 'Next run: Not scheduled');
				copy.createDiv({ cls: 'ai-scheduler-task-next', text: nextText });
			}

			const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });

			if (isRunning) {
				makeButton(controls, 'Reset / stop', () => {
					new ConfirmModal(
						this.app,
						`Reset and stop running task #${job.taskNumber} (${job.title})? If the AI backend is currently processing, it will be marked as cancelled/failed.`,
						() => {
							void (async () => {
								await this.plugin.resetRunningJob(job);
								new Notice(`Reset task #${job.taskNumber}.`);
								this.render();
							})();
						}
					).open();
				}, false, true);
			} else {
				makeButton(controls, 'Run now', () => {
					new ConfirmModal(
						this.app,
						`Run task #${job.taskNumber} (${job.title}) immediately? This will trigger background execution right now without waiting for its scheduled time slot.`,
						() => {
							void (async () => {
								new Notice(`Starting task #${job.taskNumber} now...`);
								await this.plugin.runJobNow(job);
								this.render();
							})();
						}
					).open();
				});
			}

			makeButton(controls, 'Edit', () => {
				this.leave(() => {
					new JobModal(this.app, this.plugin, job, () => {
						this.plugin.openDashboard();
					}).open();
				});
			});

			if (!isRunning) {
				makeButton(controls, 'Disable', async () => {
					await this.plugin.disableJob(job);
					this.render();
				}, false, false);
			}

			makeButton(controls, 'Delete', () => {
				new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
					void (async () => {
						await this.plugin.deleteJob(job);
						new Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
						this.render();
					})();
				}).open();
			}, false, true);
		}

		const disabled = this.sorted(summarizeTasks(userJobs.filter(job => isDisabledTask(job))).reverse());
		if (disabled.length) {
			this.renderSection(shell, 'Disabled tasks', 'Paused and ready to enable');
			const disabledList = shell.createDiv();
			for (const job of disabled) {
				const card = makeCard(disabledList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
				titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				this.appendTags(titleRow, job);

				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}` });
				copy.createDiv({ cls: 'ai-scheduler-task-paused', text: 'Paused (click Enable to schedule next run)' });
				const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });
				makeButton(controls, 'Edit', () => {
					this.leave(() => {
						new JobModal(this.app, this.plugin, job, () => {
							this.plugin.openDashboard();
						}).open();
					});
				});
				makeButton(controls, 'Enable', async () => {
					const pastDue = this.isJobPastDue(job);
					if (pastDue.isPastDue) {
						new PastDuePromptModal(this.app, this.plugin, job, pastDue.originalTime, () => {
							this.render();
						}).open();
						return;
					}
					await this.plugin.enableJob(job);
					this.render();
				});
				makeButton(controls, 'Delete', () => {
					new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
						void (async () => {
							await this.plugin.deleteJob(job);
							new Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
							this.render();
						})();
					}).open();
				}, false, true);
			}
		}

		const past = this.sorted(summarizeTasks(userJobs.filter(job => !job.enabled && !isDisabledTask(job))).reverse());
		if (past.length) {
			this.renderSection(shell, 'Past tasks', 'Completed or failed tasks, summarized per task');
			const pastList = shell.createDiv({ cls: 'ai-scheduler-past-tasks-scroll' });
			for (const job of past) {
				const card = makeCard(pastList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
				titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				this.appendTags(titleRow, job);

				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${job.lastStatus || job.status || 'completed'}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` });
				if (job.lastRunAt) {
					copy.createDiv({ cls: 'ai-scheduler-task-paused', text: `Last ran: ${formatDate(job.lastRunAt)}` });
				}
				const controls = card.createDiv('ai-scheduler-task-actions');
				makeButton(controls, 'View', () => {
					this.leave(() => {
						new TaskViewModal(this.app, this.plugin, job, () => {
							this.plugin.openDashboard();
						}).open();
					});
				});
				makeButton(controls, 'Run again…', () => {
					new RunAgainModal(this.app, this.plugin, job, () => this.render()).open();
				});
				makeButton(controls, 'Delete', () => {
					new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
						void (async () => {
							await this.plugin.deleteJob(job);
							new Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
							this.render();
						})();
					}).open();
				}, false, true);
			}
		}
	}

	private renderFilterBar(shell: HTMLElement, userJobs: Job[], renderLists: () => void): void {
		const bar = shell.createDiv({ cls: 'ai-scheduler-filter-bar' });
		const search = bar.createEl('input', {
			type: 'search',
			cls: 'ai-scheduler-input ai-scheduler-filter-search',
			placeholder: 'Search tasks by title, instructions, tag or #number',
		});
		search.setAttribute('aria-label', 'Search tasks');
		search.value = this.query;
		search.addEventListener('input', () => {
			this.query = search.value;
			renderLists();
		});

		const tags = [...new Set(userJobs.flatMap(job => job.tags ?? []))].sort((a, b) => a.localeCompare(b));
		if (tags.length) {
			const tagSelect = bar.createEl('select', { cls: 'ai-scheduler-select ai-scheduler-filter-select' });
			tagSelect.setAttribute('aria-label', 'Filter by tag');
			tagSelect.createEl('option', { value: '', text: 'All tags' });
			for (const tag of tags) tagSelect.createEl('option', { value: tag, text: `#${tag}` });
			tagSelect.value = tags.includes(this.tagFilter) ? this.tagFilter : '';
			tagSelect.onchange = () => {
				this.tagFilter = tagSelect.value;
				renderLists();
			};
		}

		const sortSelect = bar.createEl('select', { cls: 'ai-scheduler-select ai-scheduler-filter-select' });
		sortSelect.setAttribute('aria-label', 'Sort tasks');
		for (const key of Object.keys(SORT_LABELS) as TaskSort[]) sortSelect.createEl('option', { value: key, text: SORT_LABELS[key] });
		sortSelect.value = this.sort;
		sortSelect.onchange = () => {
			this.sort = sortSelect.value as TaskSort;
			renderLists();
		};
	}

	/** Tag chips on a task card; clicking one filters the dashboard by it. */
	private appendTags(container: HTMLElement, job: Job): void {
		for (const tag of job.tags ?? []) {
			const chip = container.createSpan({ cls: 'ai-scheduler-tag-chip', text: `#${tag}` });
			makeClickable(chip, `Show tasks tagged ${tag}`, event => {
				event.stopPropagation();
				this.tagFilter = this.tagFilter === tag ? '' : tag;
				this.render();
			});
		}
	}

	/** Approval mode: changes to existing notes waiting for the user, newest first. */
	private renderApprovals(shell: HTMLElement): void {
		const waiting = this.plugin.pendingChanges;
		if (!waiting.length) return;
		const card = makeCard(shell, 'ai-scheduler-approval-card');
		const head = card.createDiv({ cls: 'ai-scheduler-approval-head' });
		head.createDiv({ cls: 'ai-scheduler-alert-title', text: `Awaiting approval (${waiting.length})` });
		const review = (change: PendingChange) => {
			this.leave(() => {
				new ApprovalModal(this.app, this.plugin, change, () => this.plugin.openDashboard()).open();
			});
		};
		makeButton(head, waiting.length > 1 ? 'Review all' : 'Review', () => review(waiting[0]), true);
		for (const change of waiting.slice(0, 5)) {
			const row = card.createDiv({ cls: 'ai-scheduler-approval-row' });
			const text = row.createDiv({ cls: 'ai-scheduler-approval-text' });
			text.createDiv({ cls: 'ai-scheduler-task-title', text: change.path });
			text.createDiv({ cls: 'ai-scheduler-task-meta', text: `${PENDING_KIND_LABELS[change.kind]} · task #${change.taskNumber} (${change.taskTitle}) · ${formatDate(change.createdAt)}` });
			const actions = row.createDiv({ cls: 'ai-scheduler-task-actions' });
			makeButton(actions, 'Review', () => review(change));
			makeButton(actions, 'Reject', async () => {
				await this.plugin.rejectChange(change);
				new Notice(`Rejected the change to ${change.path}.`);
				this.render();
			}, false, true);
		}
		if (waiting.length > 5) card.createDiv({ cls: 'ai-scheduler-hint', text: `And ${waiting.length - 5} more. Review all to go through them one by one.` });
	}

	private renderPauseBanner(shell: HTMLElement): void {
		const settings = this.plugin.settings;
		const now = new Date();
		const block = startBlockReason(settings, now);
		if (!block) return;
		const banner = shell.createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-pause-banner' });
		const content = banner.createDiv({ cls: 'ai-scheduler-alert-content' });
		content.createSpan({ cls: 'ai-scheduler-alert-icon', text: block === 'paused' ? '⏸' : '🌙' });
		const text = content.createDiv();
		if (block === 'paused') {
			text.createDiv({
				cls: 'ai-scheduler-alert-title',
				text: settings.pausedUntil ? `Paused until ${formatDate(settings.pausedUntil)}` : 'Paused',
			});
			text.createDiv({
				cls: 'ai-scheduler-alert-desc',
				text: 'No task starts on its own. "Run now" still works. On resume, runs missed while paused follow your catch-up setting.',
			});
			makeButton(banner, 'Resume', async () => {
				await this.plugin.resumeAll();
				this.render();
			}, true);
		} else {
			text.createDiv({ cls: 'ai-scheduler-alert-title', text: `Quiet hours until ${formatDate(quietHoursEnd(now, settings.quietEnd).toISOString())}` });
			text.createDiv({ cls: 'ai-scheduler-alert-desc', text: 'Tasks that fall due now wait and run when the quiet hours end. "Run now" still works.' });
		}
	}

	private showPauseMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		const pause = (until: Date | null, label: string) => menu.addItem(item => item.setTitle(label).onClick(async () => {
			await this.plugin.pauseAll(until);
			new Notice(until ? `Paused until ${formatDate(until.toISOString())}.` : 'Paused until you resume.');
			this.render();
		}));
		const inHours = (hours: number) => new Date(Date.now() + hours * 3600000);
		const tomorrowMorning = new Date();
		tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
		tomorrowMorning.setHours(8, 0, 0, 0);
		pause(inHours(1), 'Pause for 1 hour');
		pause(inHours(4), 'Pause for 4 hours');
		pause(tomorrowMorning, 'Pause until tomorrow 08:00');
		pause(null, 'Pause until I resume');
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private showMoreMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('Export tasks to a file').onClick(() => {
			void this.plugin.exportTasksFile()
				.then(path => new Notice(`Tasks exported to ${path}.`, 8000))
				.catch(error => new Notice(`Could not export tasks: ${errorText(error)}`, 8000));
		}));
		menu.addItem(item => item.setTitle('Import tasks from a file').onClick(() => {
			new ImportTasksModal(this.app, this.plugin, () => this.render()).open();
		}));
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private getActivityTypeLabel(type: string): string {
		switch (type) {
			case 'running': return 'Running';
			case 'completed': return 'Done';
			case 'failed': return 'Failed';
			case 'planned': return 'Planned';
			case 'cancelled': return 'Reset';
			case 'deleted': return 'Deleted';
			case 'restored': return 'Restored';
			case 'skipped': return 'Skipped';
			case 'retrying': return 'Retry';
			case 'status': return 'Status';
			default: return 'Log';
		}
	}

	renderSection(parent: HTMLElement, title: string, description: string): HTMLDivElement {
		const heading = parent.createDiv('ai-scheduler-section-heading');
		heading.createEl('h2', { text: title }).addClass('ai-scheduler-section-title');
		heading.createSpan({ text: description }).addClass('ai-scheduler-section-desc');
		return heading;
	}
}
