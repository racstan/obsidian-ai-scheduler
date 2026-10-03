/*
 * AI Planner Dialog
 * Enables plain-language schedule generation with @ mention autocomplete,
 * loading animations, and interactive review/edit/discard capabilities for planned jobs.
 */
import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText, formatDate } from '../util';
import { cronFormFor, describeSchedule, previewSchedule } from '../schedule';
import { createContextPicker } from './contextPicker';
import { closeExistingSchedulerModals, makeButton, makeCard } from './dom';
import { AssistantModal } from './AssistantModal';
import { Job } from '../types';
import { attachMentionSuggest } from './mentionSuggest';
import { JobModal } from './JobModal';

function appendTaskIdBadge(container: HTMLElement, id: string): void {
	const idBadge = container.createSpan({ cls: 'ai-scheduler-task-id-badge', text: `ID: ${id}` });
	idBadge.setAttribute('title', 'Click to copy task ID');
	idBadge.onclick = (e) => {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			void navigator.clipboard.writeText(id).then(() => {
				new Notice(`Copied Task ID: ${id}`);
			});
		}
	};
}

export class PlannerModal extends Modal {
	plugin: AISchedulerPlugin;
	private plannedJobs: Job[] | null = null;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin, plannedJobs: Job[] | null = null) {
		super(app);
		this.plugin = plugin;
		this.plannedJobs = plannedJobs;
	}

	async onOpen(): Promise<void> {
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
			text: '← back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			window.setTimeout(() => {
				new AssistantModal(this.app, this.plugin).open();
			}, 50);
		};

		shell.createDiv({ cls: 'ai-scheduler-eyebrow', text: 'AI Planner' });
		shell.createEl('h1', { text: 'Plan scheduled work', cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		shell.createEl('p', { text: 'Describe your goal in plain english. Your active AI backend will design and configure the scheduled jobs.', cls: 'ai-scheduler-subtitle' });

		const readiness = this.plugin.getBackendReadiness();
		if (!readiness.ok) {
			const banner = shell.createDiv({ cls: 'ai-scheduler-alert-banner' });
			const content = banner.createDiv({ cls: 'ai-scheduler-alert-content' });
			content.createSpan({ cls: 'ai-scheduler-alert-icon', text: '⚠️' });
			const textCol = content.createDiv();
			textCol.createDiv({ cls: 'ai-scheduler-alert-title', text: 'AI backend not configured' });
			textCol.createDiv({ cls: 'ai-scheduler-alert-desc', text: readiness.message });
			const btn = banner.createEl('button', { text: 'Open settings', cls: 'mod-cta ai-scheduler-alert-btn' });
			btn.onclick = () => {
				this.close();
				window.setTimeout(() => {
					this.plugin.openSettingsTab();
				}, 50);
			};
		}

		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'What would you like AI Scheduler to do?' });
		const textarea = shell.createEl('textarea', { cls: 'ai-scheduler-textarea ai-scheduler-textarea-tall' });
		textarea.placeholder = 'E.g. Every weekday at 9:00 am, review notes modified in the last 24 hours, extract action items, and create an executive summary in AI reviews (type @ to attach files)...';
		shell.createDiv({ cls: 'ai-scheduler-hint ai-scheduler-hint-gap', text: 'Tip: Type @ in the box above to quickly search and attach vault notes/files.' });

		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'Default result folder (optional)' });
		const resultFolder = shell.createEl('input', { type: 'text', cls: 'ai-scheduler-input ai-scheduler-form-gap', placeholder: 'Optional result folder, e.g. AI Reviews or Projects/Notes' });

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);

		attachMentionSuggest({
			textarea,
			app: this.app,
			onSelect: file => {
				contextPicker.addPath(file.path);
				new Notice(`Attached to context: ${file.path}`);
			},
		});

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Create AI plan', async button => {
			const goal = textarea.value.trim();
			if (!goal) { new Notice('Describe what you want AI Scheduler to do.'); return; }

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
				new Notice(`AI created ${result.jobs.length} task(s)`, 6000);
				this.plannedJobs = result.jobs;
				this.renderResults();
			} catch (error) {
				loader.remove();
				textarea.disabled = false;
				resultFolder.disabled = false;
				button.disabled = false;
				button.setText('Create AI plan');
				new Notice(`Planning failed: ${errorText(error)}`, 8000);
			}
		}, true);
	}

	/* After planning, show the created schedules in editable cards where the user
	 * can edit, delete, or discard tasks before proceeding. */
	private renderResults(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-lg' });

		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: '← back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			window.setTimeout(() => {
				new AssistantModal(this.app, this.plugin).open();
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

			const actions = top.createDiv({ cls: 'ai-scheduler-planned-actions' });
			makeButton(actions, 'Edit', () => {
				this.close();
				window.setTimeout(() => {
					new JobModal(this.app, this.plugin, job, () => {
						new PlannerModal(this.app, this.plugin, this.plannedJobs).open();
					}).open();
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
				new AssistantModal(this.app, this.plugin).open();
			}, 50);
		}, true);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
