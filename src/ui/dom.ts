export function makeButton(parent: HTMLElement, label: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, primary = false, danger = false): HTMLButtonElement {
	const button = parent.createEl('button', { text: label });
	if (primary) button.addClass('mod-cta');
	if (danger) {
		button.addClass('mod-warning');
		button.addClass('ai-scheduler-button-danger');
	}
	button.onclick = () => { void onClick(button); };
	return button;
}

export function makeCard(parent: HTMLElement, ...extraClasses: string[]): HTMLDivElement {
	const card = parent.createEl('div');
	card.addClass('ai-scheduler-card');
	for (const extra of extraClasses) card.addClass(extra);
	return card;
}
