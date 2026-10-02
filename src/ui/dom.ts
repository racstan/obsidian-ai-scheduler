export function makeButton(parent: HTMLElement, label: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, primary = false, danger = false): HTMLButtonElement {
	const button = parent.createEl('button', { text: label });
	if (primary) button.addClass('mod-cta');
	if (danger) button.addClass('ai-scheduler-button-danger');
	button.onclick = () => { void onClick(button); };
	return button;
}

export function makeCard(parent: HTMLElement, ...extraClasses: string[]): HTMLDivElement {
	const card = parent.createDiv();
	card.addClass('ai-scheduler-card');
	for (const extra of extraClasses) card.addClass(extra);
	return card;
}

export function closeExistingSchedulerModals(currentModal?: { modalEl?: HTMLElement; contentEl?: HTMLElement }): void {
	if (typeof document === 'undefined') return;
	document.querySelectorAll('.ai-scheduler-modal').forEach(el => {
		if (currentModal && currentModal.modalEl && (el === currentModal.modalEl || el.contains(currentModal.modalEl))) {
			return;
		}
		const container = el.closest('.modal-container');
		if (container && currentModal && currentModal.contentEl && container.contains(currentModal.contentEl)) {
			return;
		}
		if (container) {
			const closeBtn = container.querySelector('.modal-close-button') as HTMLElement;
			if (closeBtn) closeBtn.click();
			else container.remove();
		}
	});
}

