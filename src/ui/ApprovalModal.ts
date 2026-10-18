import { App, Modal, Notice, TFile } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { PENDING_KIND_LABELS, PendingChange, foldDiff, lineDiff } from '../approval';
import { insertBlock } from '../output';
import { errorText, formatDate } from '../util';
import { closeExistingSchedulerModals, makeButton, releaseSchedulerModal } from './dom';

/**
 * Review one change waiting for approval: what it would do to the note, as a
 * diff, with Approve and Reject. Moves on to the next waiting change.
 */
export class ApprovalModal extends Modal {
	constructor(app: App, private plugin: AISchedulerPlugin, private change: PendingChange, private onDone?: () => void) {
		super(app);
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl, change } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell' });
		const waiting = this.plugin.pendingChanges;
		const position = waiting.findIndex(candidate => candidate.id === change.id);
		shell.createDiv({ cls: 'ai-scheduler-eyebrow', text: waiting.length > 1 ? `Awaiting approval · ${position + 1} of ${waiting.length}` : 'Awaiting approval' });
		shell.createEl('h2', { cls: 'ai-scheduler-title ai-scheduler-title-sm', text: PENDING_KIND_LABELS[change.kind] });
		shell.createDiv({ cls: 'ai-scheduler-subtitle', text: `${change.path} · from task #${change.taskNumber} (${change.taskTitle}) · ${formatDate(change.createdAt)}` });

		const existing = this.app.vault.getAbstractFileByPath(change.path);
		const before = existing instanceof TFile ? await this.app.vault.read(existing) : '';
		const after = change.kind === 'append' ? insertBlock(before, change.content, change.heading) : change.content;
		if (!(existing instanceof TFile)) {
			shell.createDiv({ cls: 'ai-scheduler-hint', text: 'This note does not exist any more; approving creates it.' });
		}

		const diffEl = shell.createDiv({ cls: 'ai-scheduler-diff' });
		const diff = foldDiff(lineDiff(before, after));
		if (!diff.some(line => line.type === 'add' || line.type === 'remove')) {
			diffEl.createDiv({ cls: 'ai-scheduler-hint', text: 'This change would not alter the note.' });
		}
		for (const line of diff) {
			if (line.type === 'fold') {
				diffEl.createDiv({ cls: 'ai-scheduler-diff-fold', text: `… ${line.count} unchanged line${line.count === 1 ? '' : 's'}` });
				continue;
			}
			const row = diffEl.createDiv({ cls: `ai-scheduler-diff-line ai-scheduler-diff-${line.type}` });
			row.createSpan({ cls: 'ai-scheduler-diff-sign', text: line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ' });
			row.createSpan({ text: line.text || ' ' });
		}

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer-wrap' });
		if (existing instanceof TFile) {
			makeButton(footer, 'Open note', () => {
				void this.app.workspace.getLeaf(true).openFile(existing);
				// Stay with the note instead of returning to the dashboard.
				this.onDone = undefined;
				this.close();
			});
		}
		makeButton(footer, 'Reject', async button => {
			button.disabled = true;
			await this.plugin.rejectChange(change);
			new Notice(`Rejected the change to ${change.path}.`);
			this.next();
		}, false, true);
		makeButton(footer, 'Approve', async button => {
			button.disabled = true;
			try {
				await this.plugin.approveChange(change);
				new Notice(`Changed ${change.path}.`);
				this.next();
			} catch (error) {
				button.disabled = false;
				new Notice(`Could not change ${change.path}: ${errorText(error)}`, 8000);
			}
		}, true);
	}

	/** Shows the next waiting change, or closes when none is left. */
	private next(): void {
		const following = this.plugin.pendingChanges[0];
		if (following) {
			this.change = following;
			void this.render();
			return;
		}
		this.close();
	}

	onClose(): void {
		releaseSchedulerModal(this);
		this.contentEl.empty();
		this.onDone?.();
	}
}
