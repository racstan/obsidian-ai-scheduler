/*
 * Task Details & Output Files Viewer Modal.
 * Displays files created or modified by a completed/past task,
 * provides one-click navigation to those files inside Obsidian,
 * and shows execution history and AI output.
 */
import { App, Modal, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { describeBinding, errorText, formatDate, formatDuration } from '../util';
import { describeSchedule } from '../schedule';
import { closeExistingSchedulerModals, makeButton, makeCard } from './dom';
import { AssistantModal, ConfirmModal } from './AssistantModal';

export interface TaskFileReference {
	path: string;
	type: 'output' | 'modified' | 'context' | 'schedule-note';
	label: string;
	exists: boolean;
	sizeBytes?: number;
	mtime?: number;
}

export class TaskViewModal extends Modal {
	plugin: AISchedulerPlugin;
	job: Job;
	onBack?: () => void;

	constructor(app: App, plugin: AISchedulerPlugin, job: Job, onBack?: () => void) {
		super(app);
		this.plugin = plugin;
		this.job = job;
		this.onBack = onBack;
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		this.render();
	}

	private getRelatedFiles(): TaskFileReference[] {
		const files: TaskFileReference[] = [];
		const seen = new Set<string>();

		const addFile = (rawPath: string, type: TaskFileReference['type'], label: string) => {
			const norm = normalizePath(rawPath.trim().replace(/^\[\[|\]\]$/g, ''));
			if (!norm || seen.has(norm)) return;
			seen.add(norm);

			const abstractFile = this.app.vault.getAbstractFileByPath(norm);
			let exists = false;
			let sizeBytes: number | undefined;
			let mtime: number | undefined;

			if (abstractFile instanceof TFile) {
				exists = true;
				sizeBytes = abstractFile.stat.size;
				mtime = abstractFile.stat.mtime;
			} else if (abstractFile instanceof TFolder) {
				exists = true;
			} else {
				// Try with .md extension
				const mdFile = this.app.vault.getAbstractFileByPath(`${norm}.md`);
				if (mdFile instanceof TFile) {
					exists = true;
					sizeBytes = mdFile.stat.size;
					mtime = mdFile.stat.mtime;
				}
			}

			files.push({
				path: norm,
				type,
				label,
				exists,
				sizeBytes,
				mtime,
			});
		};

		// 1. Primary recorded output path
		if (this.job.lastOutputPath) {
			addFile(this.job.lastOutputPath, 'output', 'Created output file');
		}

		// 2. Output files list
		if (Array.isArray(this.job.lastOutputFiles)) {
			this.job.lastOutputFiles.forEach(p => addFile(p, 'output', 'Output file'));
		}

		// 3. Configured output folder/file target
		if (this.job.output && this.job.output.folder) {
			const folder = this.job.output.folder;
			const filename = this.job.output.filename;
			if (filename) {
				addFile(`${folder}/${filename}`, 'output', 'Target output file');
			}
		}

		// 4. Mirrored schedule note
		if (this.job.notePath) {
			addFile(this.job.notePath, 'schedule-note', 'Schedule note');
		}

		// 5. Input context files
		if (Array.isArray(this.job.contextPaths)) {
			this.job.contextPaths.forEach(p => addFile(p, 'context', 'Attached context note'));
		}

		// 6. Extract any [[WikiLinks]] mentioned in the AI reply
		if (this.job.lastReply) {
			const wikiLinkRegex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
			let match: RegExpExecArray | null;
			while ((match = wikiLinkRegex.exec(this.job.lastReply)) !== null) {
				const linkTarget = match[1].trim();
				if (linkTarget) {
					addFile(linkTarget, 'modified', 'Referenced in output');
				}
			}
		}

		return files;
	}

	private openFile(path: string): void {
		const norm = normalizePath(path);
		let targetFile = this.app.vault.getAbstractFileByPath(norm);
		if (!targetFile && !norm.endsWith('.md')) {
			targetFile = this.app.vault.getAbstractFileByPath(`${norm}.md`);
		}

		if (targetFile instanceof TFile) {
			void this.app.workspace.getLeaf(false).openFile(targetFile);
			new Notice(`Opened: ${targetFile.basename}`);
			this.close();
		} else {
			void this.app.workspace.openLinkText(norm, '', false);
			new Notice(`Navigating to: ${norm}`);
			this.close();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-lg' });

		// Navigation Bar
		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: '← back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			if (this.onBack) {
				window.setTimeout(() => this.onBack!(), 50);
			} else {
				window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
			}
		};

		// Header
		const headerRow = shell.createDiv({ cls: 'ai-scheduler-task-header ai-scheduler-gap-8' });
		headerRow.createEl('h1', { text: `Task #${this.job.taskNumber} · ${this.job.title}`, cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		const idBadge = headerRow.createSpan({ cls: 'ai-scheduler-task-id-badge', text: `ID: ${this.job.id}` });
		idBadge.setAttribute('title', 'Click to copy task ID');
		idBadge.onclick = (e) => {
			e.stopPropagation();
			if (typeof navigator !== 'undefined' && navigator.clipboard) {
				void navigator.clipboard.writeText(this.job.id).then(() => {
					new Notice(`Copied Task ID: ${this.job.id}`);
				});
			}
		};

		// Overview Metadata Card
		const metaCard = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
		const metaGrid = metaCard.createDiv({ cls: 'ai-scheduler-view-grid' });

		const statusCol = metaGrid.createDiv();
		statusCol.createDiv({ cls: 'ai-scheduler-stat-label', text: 'STATUS' });
		const statusBadge = statusCol.createDiv({ cls: 'ai-scheduler-task-title' });
		const statusText = this.job.lastStatus || this.job.status || 'completed';
		statusBadge.setText(statusText.toUpperCase());

		const timingCol = metaGrid.createDiv();
		timingCol.createDiv({ cls: 'ai-scheduler-stat-label', text: 'LAST EXECUTED' });
		timingCol.createDiv({ cls: 'ai-scheduler-view-val', text: this.job.lastRunAt ? formatDate(this.job.lastRunAt) : 'Never' });

		const scheduleCol = metaGrid.createDiv();
		scheduleCol.createDiv({ cls: 'ai-scheduler-stat-label', text: 'SCHEDULE' });
		scheduleCol.createDiv({ cls: 'ai-scheduler-view-val', text: describeSchedule(this.job) });

		const backendCol = metaGrid.createDiv();
		backendCol.createDiv({ cls: 'ai-scheduler-stat-label', text: 'AI BACKEND / MODEL' });
		backendCol.createDiv({ cls: 'ai-scheduler-view-val', text: describeBinding(this.job) });

		// Error banner if failed
		if (this.job.lastError) {
			const errBanner = shell.createDiv({ cls: 'ai-scheduler-alert-banner' });
			const errContent = errBanner.createDiv({ cls: 'ai-scheduler-alert-content' });
			errContent.createSpan({ cls: 'ai-scheduler-alert-icon', text: '⚠️' });
			const errText = errContent.createDiv();
			errText.createDiv({ cls: 'ai-scheduler-alert-title', text: 'Task execution failed' });
			errText.createDiv({ cls: 'ai-scheduler-alert-desc', text: this.job.lastError });
		}

		// Files Created or Modified Section
		const relatedFiles = this.getRelatedFiles();
		const filesHeading = shell.createDiv('ai-scheduler-section-heading');
		filesHeading.createEl('h2', { text: 'Created & modified files', cls: 'ai-scheduler-section-title' });
		filesHeading.createSpan({ text: `${relatedFiles.length} file(s) associated with this task`, cls: 'ai-scheduler-section-desc' });

		const filesContainer = shell.createDiv({ cls: 'ai-scheduler-files-list' });

		if (!relatedFiles.length) {
			const empty = makeCard(filesContainer, 'ai-scheduler-card-muted');
			empty.createDiv({ text: 'No specific files recorded for this task.' });
			empty.createDiv({ cls: 'ai-scheduler-empty-sub', text: 'The AI output response is preserved below.' });
		} else {
			for (const fileRef of relatedFiles) {
				const fileCard = filesContainer.createDiv({ cls: 'ai-scheduler-file-row' });
				fileCard.onclick = () => this.openFile(fileRef.path);

				const left = fileCard.createDiv({ cls: 'ai-scheduler-file-left' });
				left.createSpan({ cls: 'ai-scheduler-file-icon', text: fileRef.path.endsWith('/') ? '📁' : '📄' });

				const details = left.createDiv({ cls: 'ai-scheduler-file-details' });
				const titleLine = details.createDiv({ cls: 'ai-scheduler-file-path', text: fileRef.path });
				if (fileRef.exists) {
					titleLine.addClass('is-existing');
				}

				const subLine = details.createDiv({ cls: 'ai-scheduler-file-meta' });
				subLine.createSpan({ cls: `ai-scheduler-file-badge ai-scheduler-file-badge-${fileRef.type}`, text: fileRef.label });
				if (fileRef.sizeBytes !== undefined) {
					const sizeKb = Math.round(fileRef.sizeBytes / 1024);
					subLine.createSpan({ text: ` · ${sizeKb} KB` });
				}
				if (fileRef.mtime) {
					subLine.createSpan({ text: ` · Modified ${formatDate(new Date(fileRef.mtime).toISOString())}` });
				}
				if (!fileRef.exists) {
					subLine.createSpan({ cls: 'ai-scheduler-file-missing', text: ' · (File not in vault)' });
				}

				const right = fileCard.createDiv({ cls: 'ai-scheduler-file-right' });
				const openBtn = right.createEl('button', {
					cls: 'ai-scheduler-open-file-btn',
					text: 'Open file ↗',
				});
				openBtn.onclick = (e) => {
					e.stopPropagation();
					this.openFile(fileRef.path);
				};
			}
		}

		// Prompt Section
		if (this.job.prompt) {
			const promptHeading = shell.createDiv('ai-scheduler-section-heading');
			promptHeading.createEl('h2', { text: 'Prompt & instructions', cls: 'ai-scheduler-section-title' });
			const promptCard = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
			promptCard.createDiv({ cls: 'ai-scheduler-prompt-preview', text: this.job.prompt });
		}

		// AI Output Section
		if (this.job.lastReply) {
			const outputHeading = shell.createDiv('ai-scheduler-section-heading');
			outputHeading.createEl('h2', { text: 'Latest AI output response', cls: 'ai-scheduler-section-title' });
			makeButton(outputHeading, '📋 Copy output', () => {
				if (typeof navigator !== 'undefined' && navigator.clipboard) {
					void navigator.clipboard.writeText(this.job.lastReply).then(() => {
						new Notice('Copied AI output to clipboard.');
					});
				}
			});

			const replyCard = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
			const replyBox = replyCard.createDiv({ cls: 'ai-scheduler-reply-preview' });
			replyBox.setText(this.job.lastReply);
		}

		// Footer
		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Close', () => this.close());
		makeButton(footer, '▶️ Run again', () => {
			new ConfirmModal(
				this.app,
				`Run task #${this.job.taskNumber} (${this.job.title}) immediately? It will execute in the background now.`,
				() => {
					void (async () => {
						new Notice(`Starting task #${this.job.taskNumber} now...`);
						await this.plugin.retryJob(this.job);
						this.close();
						if (this.onBack) this.onBack();
					})();
				}
			).open();
		});
		makeButton(footer, 'Delete task', () => {
			new ConfirmModal(
				this.app,
				`Delete task #${this.job.taskNumber}? This cannot be undone.`,
				() => {
					void (async () => {
						await this.plugin.deleteJob(this.job);
						new Notice(`Deleted task #${this.job.taskNumber}.`);
						this.close();
						if (this.onBack) this.onBack();
					})();
				}
			).open();
		}, false, true);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
