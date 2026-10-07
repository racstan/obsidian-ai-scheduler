import { App, Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { normalizeJob } from '../settings';
import { describeBinding, formatDate, isNightlyReviewJob } from '../util';
import { describeSchedule, getScheduleOccurrencesInRange, DAY_SHORT_NAMES, DAY_NAMES, MONTH_NAMES } from '../schedule';
import { closeExistingSchedulerModals, makeButton, makeCard } from './dom';
import { JobModal } from './JobModal';
import { PlannerModal } from './PlannerModal';
import { TaskViewModal } from './TaskViewModal';
import { AssistantModal } from './AssistantModal';

export interface CalendarOccurrence {
	job: Job;
	date: Date;
	timeStr: string;
	isPast: boolean;
	isCompleted: boolean;
	isReview?: boolean;
}

function toLocalDateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function formatClockTime(d: Date): string {
	const h = d.getHours();
	const m = String(d.getMinutes()).padStart(2, '0');
	const ampm = h >= 12 ? 'PM' : 'AM';
	const hour12 = h % 12 === 0 ? 12 : h % 12;
	return `${hour12}:${m} ${ampm}`;
}

export class CalendarModal extends Modal {
	plugin: AISchedulerPlugin;
	currentYear: number;
	currentMonth: number; // 0-indexed
	selectedDate: Date;
	activeFilter: 'all' | 'active' | 'paused' = 'all';
	viewMode: 'month' | 'agenda' = 'month';
	private refreshTimer: number | null = null;

	constructor(app: App, plugin: AISchedulerPlugin, initialDate: Date = new Date()) {
		super(app);
		this.plugin = plugin;
		this.currentYear = initialDate.getFullYear();
		this.currentMonth = initialDate.getMonth();
		this.selectedDate = new Date(initialDate);
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		this.render();
		this.refreshTimer = window.setInterval(() => {
			this.render();
		}, 4000);
	}

	onClose(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.empty();
	}

	private getRelevantJobs(): Job[] {
		let jobs = this.plugin.jobs;
		if (this.activeFilter === 'active') {
			jobs = jobs.filter(j => j.enabled && j.status !== 'disabled');
		} else if (this.activeFilter === 'paused') {
			jobs = jobs.filter(j => !j.enabled || j.status === 'disabled');
		}
		return jobs;
	}

	private buildOccurrencesMap(start: Date, end: Date): Map<string, CalendarOccurrence[]> {
		const map = new Map<string, CalendarOccurrence[]>();
		const now = new Date();
		const jobs = this.getRelevantJobs();

		for (const job of jobs) {
			const dates = getScheduleOccurrencesInRange(job.schedule, start, end, 150);
			for (const d of dates) {
				const key = toLocalDateKey(d);
				if (!map.has(key)) map.set(key, []);
				const isJobCompleted = job.status === 'completed';
				const isOnceCompleted = job.schedule?.kind === 'once' && (job.status === 'completed' || Boolean(job.lastRunAt));
				const isPastCompleted = (d < now) && job.status !== 'failed' && job.status !== 'running';
				const isCompleted = isJobCompleted || isOnceCompleted || isPastCompleted;

				map.get(key)!.push({
					job,
					date: d,
					timeStr: formatClockTime(d),
					isPast: d < now,
					isCompleted,
					isReview: isNightlyReviewJob(job),
				});
			}
		}

		// Sort occurrences within each day by time
		for (const [, list] of map.entries()) {
			list.sort((a, b) => a.date.getTime() - b.date.getTime());
		}

		return map;
	}

	render(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		this.modalEl.addClass('ai-scheduler-calendar-modal');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();

		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-lg');

		// Header row with Title and Navigation actions
		const header = shell.createDiv({ cls: 'ai-scheduler-calendar-header' });
		const titleCol = header.createDiv();
		titleCol.createEl('h1', { text: 'Schedule calendar', cls: 'ai-scheduler-title' });
		titleCol.createEl('p', {
			text: 'Visualize and manage scheduled AI tasks across days, weeks, and months.',
			cls: 'ai-scheduler-subtitle',
		});

		const topActions = header.createDiv({ cls: 'ai-scheduler-calendar-top-actions' });
		makeButton(topActions, '📋 Task dashboard', () => {
			this.close();
			window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
		});
		makeButton(topActions, '⚡ Ask AI to plan', () => {
			this.close();
			window.setTimeout(() => new PlannerModal(this.app, this.plugin).open(), 50);
		});
		makeButton(topActions, '+ New task', () => {
			this.close();
			window.setTimeout(() => {
				new JobModal(this.app, this.plugin, normalizeJob({ prompt: '', title: '' }), () => {
					new CalendarModal(this.app, this.plugin, this.selectedDate).open();
				}).open();
			}, 50);
		}, true);

		// Controls Bar: Month Nav, Today button, Filter dropdown, View toggle
		const controlsBar = shell.createDiv({ cls: 'ai-scheduler-cal-controls' });

		// Left: Month Navigation
		const navGroup = controlsBar.createDiv({ cls: 'ai-scheduler-cal-nav' });
		const prevBtn = navGroup.createEl('button', { text: '‹', cls: 'ai-scheduler-cal-nav-btn' });
		prevBtn.setAttribute('title', 'Previous month');
		prevBtn.onclick = () => {
			if (this.currentMonth === 0) {
				this.currentMonth = 11;
				this.currentYear -= 1;
			} else {
				this.currentMonth -= 1;
			}
			this.render();
		};

		navGroup.createDiv({
			cls: 'ai-scheduler-cal-month-title',
			text: `${MONTH_NAMES[this.currentMonth + 1]} ${this.currentYear}`,
		});

		const nextBtn = navGroup.createEl('button', { text: '›', cls: 'ai-scheduler-cal-nav-btn' });
		nextBtn.setAttribute('title', 'Next month');
		nextBtn.onclick = () => {
			if (this.currentMonth === 11) {
				this.currentMonth = 0;
				this.currentYear += 1;
			} else {
				this.currentMonth += 1;
			}
			this.render();
		};

		const todayBtn = navGroup.createEl('button', { text: 'Today', cls: 'ai-scheduler-cal-today-btn' });
		todayBtn.onclick = () => {
			const today = new Date();
			this.currentYear = today.getFullYear();
			this.currentMonth = today.getMonth();
			this.selectedDate = today;
			this.render();
		};

		// Right: Filter & View Mode toggles
		const filterGroup = controlsBar.createDiv({ cls: 'ai-scheduler-cal-filter-group' });

		const filterSelect = filterGroup.createEl('select', { cls: 'dropdown ai-scheduler-cal-select' });
		filterSelect.createEl('option', { text: 'All tasks', value: 'all' });
		filterSelect.createEl('option', { text: 'Active tasks only', value: 'active' });
		filterSelect.createEl('option', { text: 'Paused / disabled', value: 'paused' });
		filterSelect.value = this.activeFilter;
		filterSelect.onchange = () => {
			this.activeFilter = filterSelect.value as typeof this.activeFilter;
			this.render();
		};

		const viewToggle = filterGroup.createDiv({ cls: 'ai-scheduler-cal-view-toggle' });
		const monthModeBtn = viewToggle.createEl('button', {
			text: '📅 Month',
			cls: `ai-scheduler-cal-toggle-btn ${this.viewMode === 'month' ? 'is-active' : ''}`,
		});
		monthModeBtn.onclick = () => {
			this.viewMode = 'month';
			this.render();
		};

		const agendaModeBtn = viewToggle.createEl('button', {
			text: '📆 Timeline',
			cls: `ai-scheduler-cal-toggle-btn ${this.viewMode === 'agenda' ? 'is-active' : ''}`,
		});
		agendaModeBtn.onclick = () => {
			this.viewMode = 'agenda';
			this.render();
		};

		// Date Boundaries for current view
		const firstOfMonth = new Date(this.currentYear, this.currentMonth, 1);
		const lastOfMonth = new Date(this.currentYear, this.currentMonth + 1, 0, 23, 59, 59, 999);
		const startDayOfWeek = firstOfMonth.getDay(); // 0 = Sun
		const daysInMonth = lastOfMonth.getDate();

		// Compute grid range including padding days
		const gridStart = new Date(firstOfMonth);
		gridStart.setDate(gridStart.getDate() - startDayOfWeek);
		gridStart.setHours(0, 0, 0, 0);

		const gridEnd = new Date(lastOfMonth);
		const trailingDays = (7 - ((startDayOfWeek + daysInMonth) % 7)) % 7;
		gridEnd.setDate(gridEnd.getDate() + trailingDays);
		gridEnd.setHours(23, 59, 59, 999);

		const occurrencesMap = this.buildOccurrencesMap(gridStart, gridEnd);

		if (this.viewMode === 'month') {
			this.renderMonthGrid(shell, gridStart, gridEnd, occurrencesMap);
			this.renderDayDetails(shell, this.selectedDate, occurrencesMap);
		} else {
			this.renderAgendaView(shell, firstOfMonth, lastOfMonth, occurrencesMap);
		}

		// Render vault event tasks section if any exist
		this.renderEventTasksSection(shell);
	}

	private renderMonthGrid(
		container: HTMLElement,
		gridStart: Date,
		gridEnd: Date,
		occurrencesMap: Map<string, CalendarOccurrence[]>,
	): void {
		const calCard = makeCard(container, 'ai-scheduler-cal-card');
		const grid = calCard.createDiv({ cls: 'ai-scheduler-cal-grid' });

		// Weekday Headers
		const headerRow = grid.createDiv({ cls: 'ai-scheduler-cal-weekdays' });
		for (const name of DAY_SHORT_NAMES) {
			headerRow.createDiv({ cls: 'ai-scheduler-cal-weekday-cell', text: name });
		}

		// Days Grid
		const daysGrid = grid.createDiv({ cls: 'ai-scheduler-cal-days' });
		const todayKey = toLocalDateKey(new Date());
		const selectedKey = toLocalDateKey(this.selectedDate);

		const cur = new Date(gridStart);
		while (cur <= gridEnd) {
			const dateKey = toLocalDateKey(cur);
			const cellDate = new Date(cur);
			const isCurrentMonth = cur.getMonth() === this.currentMonth;
			const isToday = dateKey === todayKey;
			const isSelected = dateKey === selectedKey;
			const occurrences = occurrencesMap.get(dateKey) || [];

			const cell = daysGrid.createDiv({
				cls: `ai-scheduler-cal-day-cell ${isCurrentMonth ? '' : 'is-outside'} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`,
			});

			const cellTop = cell.createDiv({ cls: 'ai-scheduler-cal-cell-top' });
			cellTop.createSpan({ cls: 'ai-scheduler-cal-day-num', text: String(cellDate.getDate()) });

			if (occurrences.length > 0) {
				const countBadge = cellTop.createSpan({
					cls: 'ai-scheduler-cal-count-badge',
					text: String(occurrences.length),
				});
				countBadge.setAttribute('title', `${occurrences.length} task(s) on this day`);
			}

			// Task chips inside cell (fully scrollable within the fixed window)
			const chipsContainer = cell.createDiv({ cls: 'ai-scheduler-cal-chips' });

			for (const occ of occurrences) {
				const isRunning = occ.job.status === 'running' || this.plugin.runningJobs.has(occ.job.id);
				const chip = chipsContainer.createDiv({
					cls: `ai-scheduler-cal-chip ${occ.isReview ? 'is-review' : ''} ${isRunning ? 'is-running' : ''} ${occ.isCompleted ? 'is-completed' : ''} ${!occ.job.enabled ? 'is-paused' : ''}`,
				});
				if (occ.isCompleted) {
					chip.createSpan({ cls: 'ai-scheduler-cal-chip-check', text: '✓' });
				}
				chip.createSpan({ cls: 'ai-scheduler-cal-chip-time', text: occ.timeStr });
				const titleText = occ.isReview ? 'Periodic Review' : `#${occ.job.taskNumber ?? ''} ${occ.job.title}`;
				chip.createSpan({ cls: 'ai-scheduler-cal-chip-title', text: titleText });
				chip.setAttribute('title', `${occ.isCompleted ? '[Completed] ' : ''}${occ.timeStr} — ${titleText} (${describeSchedule(occ.job)})`);
			}

			cell.onclick = () => {
				this.selectedDate = cellDate;
				this.render();
			};

			cur.setDate(cur.getDate() + 1);
		}
	}

	private renderDayDetails(
		container: HTMLElement,
		date: Date,
		occurrencesMap: Map<string, CalendarOccurrence[]>,
	): void {
		const key = toLocalDateKey(date);
		const occurrences = occurrencesMap.get(key) || [];
		const dateFormatted = formatDate(date.toISOString()).split(' at ')[0] || `${MONTH_NAMES[date.getMonth() + 1]} ${date.getDate()}, ${date.getFullYear()}`;

		const panel = makeCard(container, 'ai-scheduler-cal-day-panel');
		const panelHead = panel.createDiv({ cls: 'ai-scheduler-cal-panel-header' });

		const titleBlock = panelHead.createDiv();
		titleBlock.createEl('h3', { text: `Tasks for ${dateFormatted}`, cls: 'ai-scheduler-cal-panel-title' });
		titleBlock.createDiv({
			cls: 'ai-scheduler-cal-panel-subtitle',
			text: occurrences.length === 0
				? 'No scheduled tasks for this date.'
				: `${occurrences.length} task run${occurrences.length === 1 ? '' : 's'} scheduled`,
		});

		const headActions = panelHead.createDiv({ cls: 'ai-scheduler-cal-panel-actions' });
		makeButton(headActions, '+ Schedule Task', () => {
			this.close();
			window.setTimeout(() => {
				const defaultJob = normalizeJob({
					prompt: '',
					title: '',
					schedule: {
						kind: 'once',
						at: new Date(this.selectedDate.getFullYear(), this.selectedDate.getMonth(), this.selectedDate.getDate(), 9, 0).toISOString(),
					},
				});
				new JobModal(this.app, this.plugin, defaultJob, () => {
					new CalendarModal(this.app, this.plugin, this.selectedDate).open();
				}).open();
			}, 50);
		});

		if (occurrences.length === 0) {
			const empty = panel.createDiv({ cls: 'ai-scheduler-empty' });
			empty.createDiv({ cls: 'ai-scheduler-empty-title', text: 'No tasks scheduled on this day' });
			empty.createDiv({
				cls: 'ai-scheduler-empty-desc',
				text: 'You can create a new recurring or one-time AI task to run on this day.',
			});
			return;
		}

		const list = panel.createDiv({ cls: 'ai-scheduler-cal-timeline-list' });

		for (const occ of occurrences) {
			const job = occ.job;
			const isRunning = job.status === 'running' || this.plugin.runningJobs.has(job.id);
			const card = list.createDiv({
				cls: `ai-scheduler-cal-timeline-item ${isRunning ? 'is-running' : ''} ${occ.isCompleted ? 'is-completed' : ''} ${!job.enabled ? 'is-paused' : ''}`,
			});

			// Left time pillar
			const timePillar = card.createDiv({ cls: 'ai-scheduler-cal-timeline-time' });
			timePillar.createSpan({ cls: 'ai-scheduler-cal-time-badge', text: occ.timeStr });

			// Main content
			const body = card.createDiv({ cls: 'ai-scheduler-cal-timeline-body' });
			const row = body.createDiv({ cls: 'ai-scheduler-cal-timeline-top' });

			const title = occ.isReview
				? 'Periodic Review'
				: `#${job.taskNumber ?? '?'} ${job.title}`;
			row.createEl('h4', { text: title, cls: `ai-scheduler-cal-item-title ${occ.isCompleted ? 'is-completed-title' : ''}` });

			const metaRow = body.createDiv({ cls: 'ai-scheduler-cal-timeline-meta' });
			if (occ.isCompleted) {
				metaRow.createSpan({ cls: 'ai-scheduler-badge ai-scheduler-badge-completed', text: '✓ Completed' });
			}
			metaRow.createSpan({ cls: 'ai-scheduler-badge', text: describeSchedule(job) });
			metaRow.createSpan({ cls: 'ai-scheduler-badge ai-scheduler-badge-backend', text: describeBinding(job) });

			if (job.output?.folder) {
				metaRow.createSpan({ cls: 'ai-scheduler-badge ai-scheduler-badge-folder', text: `📁 ${job.output.folder}` });
			}

			if (job.prompt && !occ.isReview) {
				const promptPreview = job.prompt.length > 140 ? `${job.prompt.slice(0, 140)}...` : job.prompt;
				body.createDiv({ cls: 'ai-scheduler-cal-prompt-preview', text: `“${promptPreview}”` });
			}

			// Actions
			const actions = card.createDiv({ cls: 'ai-scheduler-cal-timeline-actions' });
			makeButton(actions, occ.isCompleted ? '▶ Run again' : '▶ Run now', () => {
				void (async () => {
					new Notice(`Starting Task #${job.taskNumber ?? ''} (${job.title})...`);
					await this.plugin.retryJob(job);
					this.render();
				})();
			});
			makeButton(actions, '✏ Edit', () => {
				this.close();
				window.setTimeout(() => {
					new JobModal(this.app, this.plugin, job, () => {
						new CalendarModal(this.app, this.plugin, this.selectedDate).open();
					}).open();
				}, 50);
			});
			makeButton(actions, '👁 Details', () => {
				this.close();
				window.setTimeout(() => {
					new TaskViewModal(this.app, this.plugin, job, () => {
						new CalendarModal(this.app, this.plugin, this.selectedDate).open();
					}).open();
				}, 50);
			});
		}
	}

	private renderAgendaView(
		container: HTMLElement,
		start: Date,
		end: Date,
		occurrencesMap: Map<string, CalendarOccurrence[]>,
	): void {
		const agendaCard = makeCard(container, 'ai-scheduler-cal-card');
		agendaCard.createEl('h3', {
			text: `Upcoming Task Schedule — ${MONTH_NAMES[this.currentMonth + 1]} ${this.currentYear}`,
			cls: 'ai-scheduler-cal-panel-title',
		});

		// Collect all occurrences in the month in order
		const allOccurrences: CalendarOccurrence[] = [];
		const sortedKeys = Array.from(occurrencesMap.keys()).sort();

		for (const key of sortedKeys) {
			const list = occurrencesMap.get(key) || [];
			for (const occ of list) {
				if (occ.date >= start && occ.date <= end) {
					allOccurrences.push(occ);
				}
			}
		}

		if (allOccurrences.length === 0) {
			const empty = agendaCard.createDiv({ cls: 'ai-scheduler-empty' });
			empty.createDiv({ cls: 'ai-scheduler-empty-title', text: 'No tasks scheduled in this month' });
			empty.createDiv({
				cls: 'ai-scheduler-empty-desc',
				text: 'Create a scheduled task or use the AI planner to automate your routine.',
			});
			return;
		}

		const timeline = agendaCard.createDiv({ cls: 'ai-scheduler-cal-agenda-list' });
		let lastDateKey = '';

		for (const occ of allOccurrences) {
			const dateKey = toLocalDateKey(occ.date);
			if (dateKey !== lastDateKey) {
				lastDateKey = dateKey;
				const dayHeader = timeline.createDiv({ cls: 'ai-scheduler-cal-agenda-date-header' });
				const dayFormatted = `${DAY_NAMES[occ.date.getDay()]}, ${MONTH_NAMES[occ.date.getMonth() + 1]} ${occ.date.getDate()}`;
				dayHeader.createSpan({ text: dayFormatted });
			}

			const job = occ.job;
			const isRunning = job.status === 'running' || this.plugin.runningJobs.has(job.id);
			const row = timeline.createDiv({
				cls: `ai-scheduler-cal-agenda-row ${isRunning ? 'is-running' : ''} ${occ.isCompleted ? 'is-completed' : ''} ${!job.enabled ? 'is-paused' : ''}`,
			});

			row.createSpan({ cls: 'ai-scheduler-cal-agenda-time', text: occ.timeStr });

			const mainCol = row.createDiv({ cls: 'ai-scheduler-cal-agenda-main' });
			const titleText = occ.isReview ? 'Periodic Review' : `#${job.taskNumber ?? '?'} ${job.title}`;
			mainCol.createDiv({
				cls: `ai-scheduler-cal-agenda-title ${occ.isCompleted ? 'is-completed-title' : ''}`,
				text: occ.isCompleted ? `✓ ${titleText}` : titleText,
			});
			mainCol.createDiv({ cls: 'ai-scheduler-cal-agenda-sub', text: `${describeBinding(job)} · ${describeSchedule(job)}` });

			const actions = row.createDiv({ cls: 'ai-scheduler-cal-agenda-actions' });
			makeButton(actions, '▶ Run', () => {
				void (async () => {
					new Notice(`Starting Task #${job.taskNumber ?? ''}...`);
					await this.plugin.retryJob(job);
					this.render();
				})();
			});
			makeButton(actions, '👁 View', () => {
				this.close();
				window.setTimeout(() => {
					new TaskViewModal(this.app, this.plugin, job, () => {
						new CalendarModal(this.app, this.plugin, this.selectedDate).open();
					}).open();
				}, 50);
			});
		}
	}

	private renderEventTasksSection(container: HTMLElement): void {
		const eventJobs = this.plugin.jobs.filter(j => j.schedule?.kind === 'event');
		if (eventJobs.length === 0) return;

		const card = makeCard(container, 'ai-scheduler-cal-event-card');
		const head = card.createDiv({ cls: 'ai-scheduler-cal-event-head' });
		head.createEl('h4', { text: `⚡ Event-Triggered Tasks (${eventJobs.length})` });
		head.createDiv({
			cls: 'ai-scheduler-cal-event-desc',
			text: 'These tasks execute automatically whenever vault files change, rather than at a fixed calendar time.',
		});

		const list = card.createDiv({ cls: 'ai-scheduler-cal-event-list' });
		for (const job of eventJobs) {
			const item = list.createDiv({ cls: 'ai-scheduler-cal-event-item' });
			const top = item.createDiv({ cls: 'ai-scheduler-cal-event-item-top' });
			top.createSpan({ cls: 'ai-scheduler-cal-event-title', text: `#${job.taskNumber ?? '?'} ${job.title}` });
			top.createSpan({
				cls: `ai-scheduler-badge ${job.enabled ? 'is-enabled' : 'is-disabled'}`,
				text: job.enabled ? 'Active on file change' : 'Paused',
			});

			const sub = item.createDiv({ cls: 'ai-scheduler-cal-event-sub' });
			const cooldown = job.cooldownMinutes ? `${job.cooldownMinutes} min cooldown` : '10 min cooldown';
			sub.createSpan({ text: `${describeBinding(job)} · Trigger: vault modify · ${cooldown}` });

			const actions = item.createDiv({ cls: 'ai-scheduler-cal-event-actions' });
			makeButton(actions, '▶ Run now', () => {
				void (async () => {
					new Notice(`Starting Task #${job.taskNumber ?? ''}...`);
					await this.plugin.retryJob(job);
					this.render();
				})();
			});
			makeButton(actions, '✏ Edit', () => {
				this.close();
				window.setTimeout(() => {
					new JobModal(this.app, this.plugin, job, () => {
						new CalendarModal(this.app, this.plugin, this.selectedDate).open();
					}).open();
				}, 50);
			});
		}
	}
}
