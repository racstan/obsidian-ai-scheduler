/*
 * Starter templates. "Use template" opens the task editor pre-filled; the task
 * is only created when the user saves it there.
 */
import { App, Modal } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { normalizeJob } from '../settings';
import { describeSchedule } from '../schedule';
import { OUTPUT_MODE_LABELS, outputMode } from '../output';
import { TASK_TEMPLATES, TaskTemplate } from '../templates';
import { closeExistingSchedulerModals, makeButton, makeCard, releaseSchedulerModal } from './dom';
import { JobModal } from './JobModal';
import { AssistantModal } from './AssistantModal';

export class TemplateModal extends Modal {
	constructor(app: App, private plugin: AISchedulerPlugin) {
		super(app);
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-md');
		this.contentEl.addClass('ai-scheduler-content');
		const shell = this.contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-md' });

		const nav = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const back = nav.createEl('button', { cls: 'ai-scheduler-back-btn', text: 'Back to dashboard' });
		back.onclick = () => this.navigate(() => new AssistantModal(this.app, this.plugin).open());

		shell.createEl('h2', { text: 'New task from a template' });
		shell.createEl('p', {
			cls: 'ai-scheduler-subtitle',
			text: 'Pick a starting point. The task editor opens with everything filled in, so you can change it before saving.',
		});

		const list = shell.createDiv({ cls: 'ai-scheduler-template-list' });
		for (const template of TASK_TEMPLATES) this.renderTemplate(list, template);
	}

	private renderTemplate(list: HTMLElement, template: TaskTemplate): void {
		const card = makeCard(list, 'ai-scheduler-template-card');
		const text = card.createDiv({ cls: 'ai-scheduler-template-text' });
		text.createDiv({ cls: 'ai-scheduler-task-title', text: template.title });
		text.createDiv({ cls: 'ai-scheduler-template-desc', text: template.description });
		const details = [describeSchedule({ schedule: template.schedule }), OUTPUT_MODE_LABELS[outputMode(template.output)].toLowerCase()];
		if (template.onlyIfChanged) details.push('only when something changed');
		text.createDiv({ cls: 'ai-scheduler-task-meta', text: details.join(' · ') });
		if (template.tip) text.createDiv({ cls: 'ai-scheduler-hint', text: template.tip });
		makeButton(card, 'Use template', () => this.useTemplate(template), true);
	}

	private useTemplate(template: TaskTemplate): void {
		const job = normalizeJob({
			title: template.title,
			prompt: template.prompt,
			schedule: template.schedule,
			output: template.output ?? null,
			onlyIfChanged: template.onlyIfChanged,
			tags: template.tags,
			source: 'template',
		});
		this.navigate(() => new JobModal(this.app, this.plugin, job, () => {
			new AssistantModal(this.app, this.plugin).open();
		}).open());
	}

	private navigate(open: () => void): void {
		this.close();
		window.setTimeout(open, 50);
	}

	onClose(): void {
		releaseSchedulerModal(this);
		this.contentEl.empty();
	}
}
