/*
 * AI Planner Dialog
 * Enables plain-language schedule generation with @ mention autocomplete,
 * loading animations, and interactive review/edit/discard capabilities for planned jobs.
 */
import { Modal, Notice } from 'obsidian';
import { PLANNER_DRAFT } from '../drafts';
import { PastTimePlanError } from '../planCheck';
import { bindDraft } from './draftBanner';
import { AISchedulerPlugin } from '../main';
import { errorText, formatDate } from '../util';
import { cronFormFor, describeSchedule, previewSchedule } from '../schedule';
import { createContextPicker } from './contextPicker';
import { closeExistingSchedulerModals, linkLabel, makeButton, makeCard, makeClickable, releaseSchedulerModal } from './dom';
import { renderBackendBar } from './backendBar';
import { FolderSuggest } from './folderSuggest';
import { attachLinkHighlight } from './linkHighlight';
import { Job } from '../types';
import { attachMentionSuggest } from './mentionSuggest';
import { JobModal } from './JobModal';

function appendTaskIdBadge(container: HTMLElement, id: string): void {
	const idBadge = container.createSpan({ cls: 'ai-scheduler-task-id-badge', text: `ID: ${id}` });
	idBadge.setAttribute('title', 'Click to copy task ID');
	makeClickable(idBadge, `Copy task ID ${id}`, (e) => {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			void navigator.clipboard.writeText(id).then(() => {
				new Notice(`Copied task ID: ${id}`);
			});
		}
	});
}

/** "12:00 PM" today, "tomorrow at 12:00 PM", otherwise the date and time. */
function shortWhen(iso: string, now: Date): string {
	const date = new Date(iso);
	const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (date.toDateString() === now.toDateString()) return time;
	if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
	return formatDate(iso);
}

export class PlannerModal extends Modal {
	plugin: AISchedulerPlugin;
	private plannedJobs: Job[] | null = null;
	private detachMention: (() => void) | null = null;
	private detachHighlight: (() => void) | null = null;
	/** Saves the typed request when the window closes before it went through. */
	private saveDraftOnClose: (() => void) | null = null;
	/** False once the window is closed; a failure then falls back to a notice. */
	private shown = false;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin, plannedJobs: Job[] | null = null) {
		super(app);
		this.plugin = plugin;
		this.plannedJobs = plannedJobs;
	}

	async onOpen(): Promise<void> {
		this.shown = true;
		closeExistingSchedulerModals(this);
		if (this.plannedJobs && this.plannedJobs.length) this.renderResults();
		else await this.renderForm();
	}

	private async renderForm(): Promise<void> {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-md');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-md' });

		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: 'Back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			window.setTimeout(() => {
				this.plugin.openDashboard();
			}, 50);
		};

		shell.createDiv({ cls: 'ai-scheduler-eyebrow', text: 'AI Planner' });
		shell.createEl('h1', { text: 'Plan scheduled work', cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		shell.createEl('p', { text: 'Describe your goal in plain English. Your active AI backend will design and configure the scheduled jobs.', cls: 'ai-scheduler-subtitle' });

		renderBackendBar(shell, this.plugin, then => {
			this.close();
			window.setTimeout(then, 50);
		});

		const goalLabel = shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'What would you like AI Scheduler to do?' });
		const textarea = shell.createEl('textarea', { cls: 'ai-scheduler-textarea ai-scheduler-textarea-tall' });
		linkLabel(goalLabel, textarea);
		textarea.placeholder = 'E.g. Every weekday at 9:00 am, review notes modified in the last 24 hours, extract action items, and create an executive summary in AI reviews (type @ to attach notes or folders)...';
		this.detachHighlight?.();
		this.detachHighlight = attachLinkHighlight(textarea);
		shell.createDiv({ cls: 'ai-scheduler-hint ai-scheduler-hint-gap', text: 'Tip: Type @ in the box above to search and attach notes, files or folders.' });

		// The plugin-wide default lives in settings; this is just for this plan.
		const folderLabel = shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'Result folder (optional)' });
		const resultFolder = shell.createEl('input', { type: 'text', cls: 'ai-scheduler-input ai-scheduler-form-gap', placeholder: 'Type or pick a folder, e.g. AI Reviews or Projects/Notes' });
		linkLabel(folderLabel, resultFolder);
		new FolderSuggest(this.app, resultFolder);

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);

		this.detachMention?.();
		this.detachMention = attachMentionSuggest({
			textarea,
			app: this.app,
			onSelect: item => {
				contextPicker.addPath(item.path);
				new Notice(`Attached to context: ${item.path}`);
			},
		});

		const draft = bindDraft({ plugin: this.plugin, key: PLANNER_DRAFT, before: goalLabel, textarea, contextPicker, resultFolder });
		this.saveDraftOnClose = draft.capture;

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		let problem: HTMLElement | null = null;
		const clearProblem = () => { problem?.remove(); problem = null; };
		const planned = (jobs: Job[]) => {
			new Notice(`AI created ${jobs.length} task(s)`, 6000);
			draft.clear();
			this.saveDraftOnClose = null;
			this.plannedJobs = jobs;
			this.renderResults();
		};
		/** Shows why planning failed right above the buttons, not only in a passing notice. */
		const showProblem = (error: unknown) => {
			clearProblem();
			if (!this.shown) {
				new Notice(`Planning failed: ${errorText(error).replace(/[.\s]+$/, '')}. Your request is saved as a draft.`, 8000);
				return;
			}
			problem = createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-plan-problem' });
			footer.parentElement?.insertBefore(problem, footer);
			const actions = createDiv({ cls: 'ai-scheduler-plan-problem-actions' });
			if (error instanceof PastTimePlanError) {
				const now = new Date();
				const many = error.times.length > 1;
				problem.createDiv({ cls: 'ai-scheduler-alert-title', text: many ? 'Those times have already passed' : 'That time has already passed' });
				problem.createDiv({
					cls: 'ai-scheduler-alert-desc',
					text: `Unless you've built a time machine, ${shortWhen(error.times[0], now)} is already behind us (it's ${shortWhen(now.toISOString(), now)} now). Did you mean a later time?`,
				});
				problem.appendChild(actions);
				makeButton(actions, many ? 'Move them to the next day' : `Schedule for ${shortWhen(error.nextTimes[0], now)}`, async button => {
					button.disabled = true;
					try {
						planned(await error.reschedule());
					} catch (rescheduleError) {
						showProblem(rescheduleError);
					}
				}, true);
				makeButton(actions, 'Change the time', () => {
					clearProblem();
					textarea.focus();
				});
			} else {
				problem.createDiv({ cls: 'ai-scheduler-alert-title', text: 'Planning didn\'t work this time' });
				problem.createDiv({ cls: 'ai-scheduler-alert-desc', text: errorText(error) });
				problem.createDiv({ cls: 'ai-scheduler-alert-desc ai-scheduler-plan-problem-hint', text: 'Your request is saved as a draft. Reword it and try again, or check your AI backend.' });
			}
			problem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		};

		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Create AI plan', async button => {
			const goal = textarea.value.trim();
			if (!goal) { new Notice('Describe what you want AI Scheduler to do.'); return; }
			clearProblem();

			button.disabled = true;
			button.setText('AI is planning...');
			textarea.disabled = true;
			resultFolder.disabled = true;

			const loader = shell.createDiv({ cls: 'ai-scheduler-planning-card' });
			loader.createDiv({ cls: 'ai-scheduler-spinner' });
			loader.createDiv({ cls: 'ai-scheduler-planning-title', text: 'AI is designing your schedule...' });
			loader.createDiv({ cls: 'ai-scheduler-planning-subtitle', text: 'Analyzing your goal, determining timing cadences, and generating scheduled task definitions.' });
			loader.scrollIntoView({ behavior: 'smooth' });

			try {
				const result = await this.plugin.planAndCreate(goal, contextPicker.getPaths(), resultFolder.value.trim());
				planned(result.jobs);
			} catch (error) {
				loader.remove();
				textarea.disabled = false;
				resultFolder.disabled = false;
				button.disabled = false;
				button.setText('Create AI plan');
				draft.fail(errorText(error));
				showProblem(error);
			}
		}, true);
	}

	/* After planning, show the created schedules in editable cards where the user
	 * can edit, delete, or discard tasks before proceeding. */
	private renderResults(): void {
		this.detachMention?.();
		this.detachMention = null;
		this.detachHighlight?.();
		this.detachHighlight = null;
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-lg' });

		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: 'Back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			window.setTimeout(() => {
				this.plugin.openDashboard();
			}, 50);
		};

		shell.createEl('h1', { text: 'Planned schedule review', cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		shell.createEl('p', {
			text: 'AI created the following task(s). You can edit any schedule manually, adjust prompts, or discard tasks before proceeding.',
			cls: 'ai-scheduler-subtitle',
		});

		const currentJobs = (this.plannedJobs || []).map(j => this.plugin.jobs.find(existing => existing.id === j.id) || j);

		if (!currentJobs.length) {
			const empty = makeCard(shell, 'ai-scheduler-card-muted');
			empty.createDiv({ text: 'All planned tasks were discarded.' });
			const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
			makeButton(footer, 'Plan new schedule', () => {
				this.plannedJobs = null;
				void this.renderForm();
			}, true);
			return;
		}

		for (const job of currentJobs) {
			const card = shell.createDiv({ cls: 'ai-scheduler-planned-card' });
			const top = card.createDiv({ cls: 'ai-scheduler-planned-header' });
			const titleRow = top.createDiv({ cls: 'ai-scheduler-task-header' });
			titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
			appendTaskIdBadge(titleRow, job.id);
			if (job.doubt) {
				titleRow.createSpan({ cls: 'ai-scheduler-doubt-badge', text: 'Unspecified details *' });
			}

			const actions = top.createDiv({ cls: 'ai-scheduler-planned-actions' });
			makeButton(actions, 'Edit', () => {
				this.close();
				window.setTimeout(() => {
					new JobModal(this.app, this.plugin, job, () => {
						new PlannerModal(this.app, this.plugin, this.plannedJobs).open();
					}, 'Back to planner').open();
				}, 50);
			});
			makeButton(actions, 'Discard', async () => {
				await this.plugin.deleteJob(job);
				this.plannedJobs = (this.plannedJobs || []).filter(j => j.id !== job.id);
				new Notice(`Discarded: ${job.title}`);
				this.renderResults();
			}, false, true);

			const cronForm = cronFormFor(job.schedule);
			const runs = previewSchedule(job.schedule, 3);
			const meta = card.createDiv({ cls: 'ai-scheduler-task-meta' });
			meta.setText(`Schedule: ${describeSchedule(job)}${cronForm ? ` (${cronForm})` : ''} · Next: ${runs.length ? runs[0] : (job.nextRunAt ? formatDate(job.nextRunAt) : 'on trigger')}`);

			if (job.doubt) {
				const doubtBanner = card.createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-gap-8' });
				const content = doubtBanner.createDiv({ cls: 'ai-scheduler-alert-content' });
				content.createSpan({ cls: 'ai-scheduler-alert-icon', text: '💡' });
				const textCol = content.createDiv();
				textCol.createDiv({ cls: 'ai-scheduler-alert-title', text: 'AI planning note and unspecified fields' });
				textCol.createDiv({ cls: 'ai-scheduler-alert-desc', text: `${job.doubt} Default values were populated. Click 'Edit' if you wish to adjust any parameters.` });
			}

			if (job.prompt) {
				const promptBox = card.createDiv({ cls: 'ai-scheduler-task-prompt' });
				promptBox.setText(job.prompt);
			}

			if (job.contextPaths && job.contextPaths.length) {
				const ctxRow = card.createDiv({ cls: 'ai-scheduler-context-chips' });
				job.contextPaths.forEach(p => {
					const chip = ctxRow.createDiv({ cls: 'ai-scheduler-context-chip' });
					chip.createSpan({ cls: 'ai-scheduler-chip-icon', text: p.endsWith('/') ? '📁' : '📄' });
					chip.createSpan({ cls: 'ai-scheduler-chip-text', text: p });
				});
			}
		}

		const summary = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-gap');
		summary.createDiv({ cls: 'ai-scheduler-hint', text: 'Tip: You can edit or refine any task with "Edit", or edit later from the dashboard.' });

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Discard all', async () => {
			for (const job of currentJobs) {
				await this.plugin.deleteJob(job);
			}
			this.plannedJobs = null;
			new Notice('All planned tasks discarded.');
			await this.renderForm();
		}, false, true);

		makeButton(footer, 'Done & open AI Scheduler', () => {
			this.close();
			window.setTimeout(() => {
				this.plugin.openDashboard();
			}, 50);
		}, true);
	}

	onClose(): void {
		this.shown = false;
		this.saveDraftOnClose?.();
		this.saveDraftOnClose = null;
		this.detachMention?.();
		this.detachMention = null;
		this.detachHighlight?.();
		this.detachHighlight = null;
		releaseSchedulerModal(this);
		this.contentEl.empty();
	}
}
