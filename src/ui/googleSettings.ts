import { Notice, Platform, Setting } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { GOOGLE_SCOPES, SETUP_GUIDE_URL } from '../google/config';

/** The "Google Calendar (early access)" settings section. */
export function renderGoogleSettings(containerEl: HTMLElement, plugin: AISchedulerPlugin, rerender: () => void): void {
	const google = plugin.google;
	const settings = plugin.settings;
	new Setting(containerEl).setName('Google Calendar (early access)').setHeading();
	containerEl.createDiv({
		cls: 'ai-scheduler-hint ai-scheduler-settings-note',
		text: 'Optional. Connecting your Google account lets tasks read your events ({{today_events}}, {{tomorrow_events}}, {{week_events}}), run before calendar events, and show upcoming runs in an "AI Scheduler" calendar in Google. You use your own Google Cloud project, so your calendar data only goes between this device and your own Google project; nothing goes through any other server. The sign-in stays on this device and is not synced.',
	});

	// Setting up the user's own OAuth client: open until they entered one.
	const setup = containerEl.createEl('details', { cls: 'ai-scheduler-settings-advanced' });
	setup.open = !google.available && !google.connected;
	setup.createEl('summary', { text: google.available ? 'Your Google client' : 'Set up your Google client (one time, about 5 minutes)' });
	const steps = setup.createEl('ol', { cls: 'ai-scheduler-google-steps' });
	const step = (parts: Array<string | { text: string; href: string } | { code: string }>) => {
		const item = steps.createEl('li');
		for (const part of parts) {
			if (typeof part === 'string') item.appendText(part);
			else if ('href' in part) item.createEl('a', { text: part.text, href: part.href });
			else item.createEl('code', { text: part.code });
		}
	};
	step(['Open ', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com/projectcreate' }, ' and create a project (any name).']);
	step(['Enable the ', { text: 'Google Calendar API', href: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com' }, ' for it.']);
	step(['Under ', { text: 'Google Auth Platform', href: 'https://console.cloud.google.com/auth/overview' }, ', set up the consent screen: audience External, your email as contact. Under Audience, add your Google account as a test user, or click Publish app (then Google shows an "unverified app" screen for your own app; continue with Advanced).']);
	step(['Under Data access, add these scopes: ', { code: GOOGLE_SCOPES.filter(scope => scope.startsWith('https://')).map(scope => scope.replace('https://www.googleapis.com/auth/', '')).join(', ') }, '.']);
	step(['Under Clients, create a client of type ', { code: 'Desktop app' }, ' and copy its client ID and client secret here.']);
	setup.createDiv({
		cls: 'ai-scheduler-hint',
		text: 'While the app is in testing mode, Google ends the sign-in after 7 days and you connect again; publishing it avoids that. The client ID and secret are saved with the plugin settings, so synced devices share them; each device still connects on its own.',
	});
	const guide = setup.createDiv({ cls: 'ai-scheduler-hint' });
	guide.appendText('The same steps with more detail: ');
	guide.createEl('a', { text: 'README', href: SETUP_GUIDE_URL });
	new Setting(setup)
		.setName('Client ID')
		.addText(text => text.setPlaceholder('…apps.googleusercontent.com').setValue(settings.googleClientId).onChange(value => {
			void (async () => {
				settings.googleClientId = value.trim();
				await plugin.saveState();
			})();
		}));
	new Setting(setup)
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
	} else {
		account.setDesc('Enter your client ID and secret above, then connect. Google opens in your browser; allow access, then come back to Obsidian.');
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
}
