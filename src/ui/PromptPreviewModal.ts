/* Shows the exact prompt a task would send now, with variables filled in. */
import { App, Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { errorText } from '../util';
import { makeButton } from './dom';

export class PromptPreviewModal extends Modal {
	constructor(app: App, private plugin: AISchedulerPlugin, private job: Job) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-md');
		this.contentEl.addClass('ai-scheduler-content');
		this.contentEl.createEl('h3', { text: `Prompt preview · #${this.job.taskNumber} ${this.job.title}` });
		this.contentEl.createEl('p', {
			cls: 'ai-scheduler-subtitle',
			text: 'This is what the task would send to the AI if it ran now, with variables filled in. Nothing is sent.',
		});
		let prompt = '';
		const pre = this.contentEl.createEl('pre', { cls: 'ai-scheduler-prompt-preview-full', text: 'Building the prompt…' });
		// Dataview queries in the instructions run here, so this can take a moment.
		void this.plugin.previewPrompt(this.job)
			.catch(error => `Could not build the prompt: ${errorText(error)}`)
			.then(text => {
				prompt = text;
				pre.setText(text);
			});
		const footer = this.contentEl.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Copy', () => {
			void navigator.clipboard?.writeText(prompt).then(() => new Notice('Copied the prompt.'));
		});
		makeButton(footer, 'Close', () => this.close(), true);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
