import { Notice, Platform, Setting } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';

/** The "Google Calendar (early access)" settings section. */
export function renderGoogleSettings(containerEl: HTMLElement, plugin: AISchedulerPlugin, rerender: () => void): void {
	const google = plugin.google;
	const settings = plugin.settings;
	new Setting(containerEl).setName('Google Calendar (early access)').setHeading();
	containerEl.createDiv({
		cls: 'ai-scheduler-hint ai-scheduler-settings-note',
		text: 'Optional. Connecting your Google account lets tasks read your events ({{today_events}}, {{tomorrow_events}}, {{week_events}}), run before calendar events, and show upcoming runs in an "AI Scheduler" calendar in Google. The plugin talks to Google directly from this device; nothing goes through any other server. The sign-in stays on this device and is not synced. While this feature is in early access, Google may show a warning that the app is not verified yet.',
	});

	const account = new Setting(containerEl).setName('Google account');
	if (google.connected) {
		account.setDesc(`Connected${google.email ? ` as ${google.email}` : ''} on this device.`);
		account.addButton(button => button.setButtonText('Disconnect').onClick(() => {
			void (async () => {
				button.setDisabled(true);
				if (settings.googleShowRuns) {
					await google.removeRunCalendar().catch(error => new Notice(`Could not delete the AI Scheduler calendar in Google: ${errorText(error)}`, 8000));
				}
				await google.disconnect();
				settings.googleShowRuns = false;
				await plugin.saveState();
				new Notice('Google Calendar disconnected.');
				rerender();
			})();
		}));
	} else if (Platform.isMobile) {
		account.setDesc('Connect Google Calendar from Obsidian on a computer. The sign-in needs a desktop browser.');
	} else if (!google.available) {
		account.setDesc('Google Calendar is not available in this build yet. To use your own Google Cloud OAuth client, enter it under the advanced options below.');
	} else {
		account.setDesc('Opens Google in your browser. Allow access, then come back to Obsidian.');
		let cancel: AbortController | null = null;
		account.addButton(button => button.setButtonText('Connect').setCta().onClick(() => {
			if (cancel) {
				cancel.abort();
				return;
			}
			cancel = new AbortController();
			button.setButtonText('Cancel');
			account.setDesc('Waiting for Google in your browser…');
			void google.connect(cancel.signal)
				.then(() => new Notice(`Google Calendar connected${google.email ? ` as ${google.email}` : ''}.`))
				.catch(error => new Notice(errorText(error), 8000))
				.finally(() => {
					cancel = null;
					rerender();
				});
		}));
	}
	if (google.lastError) {
		containerEl.createDiv({ cls: 'ai-scheduler-status-error ai-scheduler-settings-note', text: google.lastError });
	}

	if (google.connected) {
		new Setting(containerEl)
			.setName('Show runs in Google Calendar')
			.setDesc(`Keeps an "AI Scheduler" calendar in your Google account with the upcoming runs of your tasks, without reminders. Updated from the device that runs scheduled tasks${plugin.runsTasksHere ? ' (this one)' : '; this device does not, so nothing is sent from here'}. Turning it off deletes that calendar.`)
			.addToggle(toggle => toggle.setValue(settings.googleShowRuns).onChange(value => {
				void (async () => {
					settings.googleShowRuns = value;
					await plugin.saveState();
					if (value) {
						await google.syncRuns(true)
							.then(() => new Notice('Runs added to the AI Scheduler calendar in Google.'))
							.catch(error => new Notice(errorText(error), 8000));
					} else {
						await google.removeRunCalendar().catch(error => new Notice(`Could not delete the AI Scheduler calendar in Google: ${errorText(error)}`, 8000));
					}
					rerender();
				})();
			}));
		if (settings.googleShowRuns) {
			new Setting(containerEl)
				.setName('Days ahead in Google Calendar')
				.setDesc('How far ahead runs are shown (1–60).')
				.addText(text => text.setPlaceholder('14').setValue(String(settings.googleRunDays)).onChange(value => {
					void (async () => {
						const days = Number(value);
						if (!Number.isInteger(days) || days < 1 || days > 60) return;
						settings.googleRunDays = days;
						await plugin.saveState();
					})();
				}));
		}

		const calendars = new Setting(containerEl)
			.setName('Calendars to read')
			.setDesc('Used for {{today_events}} and the others, and for tasks that run before calendar events. Loading…');
		const list = containerEl.createDiv({ cls: 'ai-scheduler-google-calendars' });
		void google.listCalendars().then(found => {
			calendars.setDesc('Used for {{today_events}} and the others, and for tasks that run before calendar events. With none chosen, your main calendar is read.');
			const chosen = new Set(settings.googleCalendars);
			for (const calendar of found) {
				const row = list.createEl('label', { cls: 'ai-scheduler-check-row' });
				const check = row.createEl('input', { type: 'checkbox' });
				check.checked = chosen.has(calendar.id) || (!chosen.size && calendar.primary);
				if (calendar.color) row.createSpan({ cls: 'ai-scheduler-google-dot' }).style.setProperty('--ai-scheduler-dot', calendar.color);
				row.createSpan({ text: calendar.primary ? `${calendar.name} (main)` : calendar.name });
				check.onchange = () => {
					void (async () => {
						const ids = new Set(settings.googleCalendars.length ? settings.googleCalendars : found.filter(entry => entry.primary).map(entry => entry.id));
						if (check.checked) ids.add(calendar.id);
						else ids.delete(calendar.id);
						settings.googleCalendars = [...ids];
						google.pollSoon();
						await plugin.saveState();
					})();
				};
			}
		}).catch(error => {
			calendars.setDesc(`Could not load your calendars: ${errorText(error)}`);
		});
	}

	const advanced = containerEl.createEl('details', { cls: 'ai-scheduler-settings-advanced' });
	advanced.createEl('summary', { text: 'Your own Google client (advanced)' });
	advanced.createDiv({
		cls: 'ai-scheduler-hint',
		text: 'Leave empty to use the plugin\'s. To use your own: in Google Cloud, enable the Google Calendar API and create an OAuth client of type "Desktop app", then paste its ID and secret here and connect again.',
	});
	new Setting(advanced)
		.setName('Client ID')
		.addText(text => text.setPlaceholder('…apps.googleusercontent.com').setValue(settings.googleClientId).onChange(value => {
			void (async () => {
				settings.googleClientId = value.trim();
				await plugin.saveState();
			})();
		}));
	new Setting(advanced)
		.setName('Client secret')
		.addText(text => {
			text.inputEl.type = 'password';
			text.setValue(settings.googleClientSecret).onChange(value => {
				void (async () => {
					settings.googleClientSecret = value.trim();
					await plugin.saveState();
				})();
			});
		});
}
