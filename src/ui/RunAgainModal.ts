import { App, Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { describeSchedule } from '../schedule';
import { errorText, formatDate } from '../util';
import { makeButton } from './dom';

/** "YYYY-MM-DDTHH:MM" in local time, as a datetime-local input expects. */
function localInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * "Run again" for a past task: run it now or at a chosen time. A task that
 * used to repeat becomes a one-time task, so running it once does not quietly
 * restart its old schedule.
 */
export class RunAgainModal extends Modal {
	constructor(app: App, private plugin: AISchedulerPlugin, private job: Job, private onDone: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, job } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-confirm-modal');
		contentEl.addClass('ai-scheduler-run-again');
		contentEl.createEl('h3', { text: 'Run again' });
		contentEl.createEl('p', { text: `#${job.taskNumber} · ${job.title}`, cls: 'ai-scheduler-run-again-task' });

		if (job.schedule.kind !== 'once') {
			const note = contentEl.createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-run-again-note' });
			note.createDiv({
				cls: 'ai-scheduler-alert-desc',
				text: `This task used to repeat (${describeSchedule(job)}). Running it again turns it into a one-time task, so its old schedule does not start again. To make it repeat, edit its schedule afterwards.`,
			});
		}

		const nowRow = contentEl.createDiv({ cls: 'ai-scheduler-run-again-row' });
		nowRow.createDiv({ cls: 'ai-scheduler-run-again-label', text: 'Run it right away' });
		makeButton(nowRow, 'Run now', () => { void this.rerun(null); }, true);

		const laterRow = contentEl.createDiv({ cls: 'ai-scheduler-run-again-row' });
		laterRow.createDiv({ cls: 'ai-scheduler-run-again-label', text: 'Or pick a time' });
		const input = laterRow.createEl('input', { type: 'datetime-local', cls: 'ai-scheduler-input ai-scheduler-run-again-time' });
		input.setAttribute('aria-label', 'Run at');
		// Default: an hour from now, on the next quarter hour.
		const suggested = new Date(Date.now() + 60 * 60_000);
		suggested.setMinutes(Math.ceil(suggested.getMinutes() / 15) * 15, 0, 0);
		input.value = localInputValue(suggested);
		input.min = localInputValue(new Date());
		const error = contentEl.createDiv({ cls: 'ai-scheduler-run-again-error' });
		makeButton(laterRow, 'Schedule', () => {
			error.setText('');
			const at = new Date(input.value);
			if (!input.value || Number.isNaN(at.getTime())) {
				error.setText('Pick a date and time first.');
				return;
			}
			if (at.getTime() <= Date.now()) {
				error.setText('Unless you\'ve built a time machine, that time has already passed. Pick a later one.');
				return;
			}
			void this.rerun(at);
		});

		const footer = contentEl.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Cancel', () => this.close());
	}

	private async rerun(at: Date | null): Promise<void> {
		const { job } = this;
		try {
			this.close();
			if (at) {
				await this.plugin.rerunJob(job, at);
				new Notice(`Task #${job.taskNumber} will run at ${formatDate(at.toISOString())}.`);
			} else {
				new Notice(`Starting task #${job.taskNumber} now...`);
				// Not awaited: the AI run can take minutes, and the window behind should update now.
				this.plugin.rerunJob(job, null).catch(error => {
					new Notice(`Could not run task #${job.taskNumber} again: ${errorText(error)}`, 8000);
				});
			}
		} catch (error) {
			new Notice(`Could not run task #${job.taskNumber} again: ${errorText(error)}`, 8000);
		}
		this.onDone();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
