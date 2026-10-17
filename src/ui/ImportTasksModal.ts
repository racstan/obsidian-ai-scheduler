/* Picks a task export (.json) from the vault and imports its tasks, paused. */
import { App, FuzzySuggestModal, Notice, TFile } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';

export class ImportTasksModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private plugin: AISchedulerPlugin, private onDone?: () => void) {
		super(app);
		this.setPlaceholder('Choose a task export file (.json) from your vault');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles()
			.filter(file => file.extension === 'json' && !file.path.startsWith(`${this.app.vault.configDir}/`))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		void (async () => {
			try {
				const count = await this.plugin.importTasksText(await this.app.vault.read(file));
				new Notice(`Imported ${count} task(s). They are paused: review them and click Enable to schedule them.`, 8000);
				this.onDone?.();
			} catch (error) {
				new Notice(`Could not import tasks: ${errorText(error)}`, 8000);
			}
		})();
	}
}
