import { AISchedulerPlugin } from '../main';
import { formatDate } from '../util';
import { ContextPickerInstance } from './contextPicker';

export interface DraftBinding {
	/** Saves what is typed now (or clears the draft when the box is empty). */
	capture: () => void;
	/** Saves what is typed now together with why the request failed. */
	fail: (error: string) => void;
	/** The request went through: forget the draft. */
	clear: () => void;
}

/**
 * Restores a saved AI request into the form (with a banner saying so) and
 * keeps it saved when the request fails or the window closes, so nothing has
 * to be typed again when a backend has a problem.
 */
export function bindDraft(options: {
	plugin: AISchedulerPlugin;
	key: string;
	/** The banner goes just before this element. */
	before: HTMLElement;
	textarea: HTMLTextAreaElement;
	contextPicker: ContextPickerInstance;
	resultFolder: HTMLInputElement;
}): DraftBinding {
	const { plugin, key, before, textarea, contextPicker, resultFolder } = options;
	const current = (error: string | null) => ({
		text: textarea.value,
		contextPaths: contextPicker.getPaths(),
		resultFolder: resultFolder.value.trim(),
		error,
	});

	const draft = plugin.getDraft(key);
	if (draft) {
		textarea.value = draft.text;
		for (const path of draft.contextPaths) contextPicker.addPath(path);
		if (draft.resultFolder) resultFolder.value = draft.resultFolder;
		// Lets the link highlighter catch up with the restored text.
		textarea.dispatchEvent(new Event('input'));

		const banner = createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-draft-banner' });
		before.parentElement?.insertBefore(banner, before);
		const content = banner.createDiv({ cls: 'ai-scheduler-alert-content' }).createDiv();
		content.createDiv({ cls: 'ai-scheduler-alert-title', text: 'Your unsent request was restored' });
		content.createDiv({
			cls: 'ai-scheduler-alert-desc',
			text: draft.error
				? `Saved ${formatDate(draft.savedAt)} when the request failed: ${draft.error}`
				: `Saved ${formatDate(draft.savedAt)} when the window was closed.`,
		});
		const clearButton = banner.createEl('button', { text: 'Clear draft' });
		clearButton.onclick = () => {
			textarea.value = '';
			textarea.dispatchEvent(new Event('input'));
			void plugin.saveDraft(key, null);
			banner.remove();
		};
	}

	return {
		capture: () => {
			// Keep the reason of an earlier failure while the request is unchanged.
			const saved = plugin.getDraft(key);
			const error = saved && saved.text === textarea.value ? saved.error : null;
			void plugin.saveDraft(key, textarea.value.trim() ? current(error) : null);
		},
		fail: error => { void plugin.saveDraft(key, current(error)); },
		clear: () => { void plugin.saveDraft(key, null); },
	};
}
