import { Notice, Platform, Setting } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { CalendarModal } from './CalendarModal';
import { errorText } from '../util';
import { CalendarAccount } from '../calendars/account';
import { GOOGLE, GOOGLE_GUIDE_URL, LINKS_GUIDE_URL, OUTLOOK_GUIDE_URL } from '../calendars/config';

/** A setting name with a "Beta" badge. */
export function betaName(text: string): DocumentFragment {
	return createFragment(fragment => {
		fragment.appendText(text);
		fragment.createSpan({ cls: 'ai-scheduler-beta', text: 'Beta' });
	});
}

type Step = Array<string | { text: string; href: string } | { code: string }>;

function renderSteps(container: HTMLElement, steps: Step[]): void {
	const list = container.createEl('ol', { cls: 'ai-scheduler-setup-steps' });
	for (const step of steps) {
		const item = list.createEl('li');
		for (const part of step) {
			if (typeof part === 'string') item.appendText(part);
			else if ('href' in part) item.createEl('a', { text: part.text, href: part.href });
			else item.createEl('code', { text: part.code });
		}
	}
}

function guideLink(container: HTMLElement, href: string): void {
	const guide = container.createDiv({ cls: 'ai-scheduler-hint' });
	guide.appendText('The same steps with more detail are in the ');
	guide.createEl('a', { text: 'README', href });
	guide.appendText('.');
}

/** The "Calendars" settings tab. */
export function renderCalendarSettings(containerEl: HTMLElement, plugin: AISchedulerPlugin, rerender: () => void): void {
	const settings = plugin.settings;

	// The built-in calendar needs nothing set up.
	new Setting(containerEl).setName('Schedule calendar').setHeading();
	new Setting(containerEl)
		.setName('Your tasks in a calendar')
		.setDesc('AI Scheduler has its own calendar of every task\'s runs (month, agenda and day views). It works without anything below.')
		.addButton(button => button.setButtonText('Open calendar').onClick(() => new CalendarModal(plugin.app, plugin).open()));

	renderIcsExport(containerEl, plugin, rerender);

	new Setting(containerEl).setName('Calendar add-ons').setHeading();
	containerEl.createDiv({
		cls: 'ai-scheduler-hint ai-scheduler-settings-note',
		text: 'Optional. Bring your other calendars in: tasks can then use your events ({{today_events}}, {{tomorrow_events}}, {{week_events}}) and run before calendar events. Google and Outlook can also show your upcoming runs. The plugin talks to your calendar directly from this device; nothing goes through any other server. Links and sign-ins are kept on this device and are not synced.',
	});

	renderLinks(containerEl, plugin, rerender);
	renderAccount(containerEl, plugin, plugin.calendars.google, rerender, {
		title: 'Google Calendar',
		intro: 'Sign in with your own free Google Cloud project to read your calendars and keep an "AI Scheduler" calendar of upcoming runs in Google. The plugin can change only that calendar. Just want to read events? A calendar link above is quicker.',
		guide: GOOGLE_GUIDE_URL,
		steps: [
			['Open ', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com/projectcreate' }, ' and create a project (any name).'],
			['Enable the ', { text: 'Google Calendar API', href: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com' }, ' for it.'],
			['Open ', { text: 'Google Auth Platform', href: 'https://console.cloud.google.com/auth/overview' }, ' and set it up: audience External, your email as contact. Under Audience, add your Google account as a test user, or click Publish app (Google then shows an "unverified app" screen for your own app; continue with Advanced).'],
			['Under Data access, add these scopes: ', { code: GOOGLE.scopes.filter(scope => scope.startsWith('https://')).map(scope => scope.replace('https://www.googleapis.com/auth/', '')).join(', ') }, '.'],
			['Under Clients, create a client of type ', { code: 'Desktop app' }, ' and copy its client ID and client secret here.'],
		],
		note: 'In testing mode Google ends the sign-in after 7 days and you connect again; publishing the app avoids that.',
		secret: true,
	});
	renderAccount(containerEl, plugin, plugin.calendars.outlook, rerender, {
		title: 'Outlook calendar',
		intro: 'Sign in with your own free Microsoft app registration to read your Outlook calendars and keep an "AI Scheduler" calendar of upcoming runs in Outlook. Microsoft has no narrower permission than read and write for calendars; the plugin changes only its own "AI Scheduler" calendar. Just want to read events? A calendar link above is quicker.',
		guide: OUTLOOK_GUIDE_URL,
		steps: [
			['Open ', { text: 'App registrations', href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }, ' in the Microsoft Entra admin center and click New registration.'],
			['Name it (e.g. AI Scheduler). Supported account types: ', { code: 'Accounts in any organizational directory and personal Microsoft accounts' }, '.'],
			['Redirect URI: platform ', { code: 'Public client/native (mobile & desktop)' }, ', address ', { code: 'http://localhost' }, '. Click Register.'],
			['Under API permissions, add Microsoft Graph → Delegated → ', { code: 'Calendars.ReadWrite' }, '.'],
			['Copy the Application (client) ID from the Overview page here. No secret is needed.'],
		],
		note: 'With a work or school account, your organization may need to allow the app first.',
		secret: false,
	});

	if (plugin.calendars.accounts.some(account => account.connected && account.settings.showRuns)) {
		new Setting(containerEl)
			.setName('Days ahead in Google and Outlook')
			.setDesc('How far ahead the "AI Scheduler" calendars show runs (1–60).')
			.addText(text => text.setPlaceholder('14').setValue(String(settings.calendarRunDays)).onChange(value => {
				void (async () => {
					const days = Number(value);
					if (!Number.isInteger(days) || days < 1 || days > 60) return;
					settings.calendarRunDays = days;
					await plugin.saveState();
				})();
			}));
	}
}

function renderIcsExport(containerEl: HTMLElement, plugin: AISchedulerPlugin, rerender: () => void): void {
	const settings = plugin.settings;
	new Setting(containerEl)
		.setName('Keep a calendar file of upcoming runs')
		.setDesc('Writes an .ics file listing every scheduled run and keeps it up to date. Import it into any calendar app for a one-time copy, or sync it with a service that gives it a public link (e.g. Dropbox) and subscribe to that link. The plugin itself never uploads it. Anyone with the link can read your task titles and prompts.')
		.addToggle(toggle => toggle.setValue(settings.icsExportEnabled).onChange(value => {
			void (async () => {
				settings.icsExportEnabled = value;
				await plugin.saveState();
				rerender();
			})();
		}));
	if (!settings.icsExportEnabled) return;
	new Setting(containerEl)
		.setName('Calendar file')
		.setDesc('Vault path of the .ics file.')
		.addText(text => text.setPlaceholder('AI Scheduler/AI Scheduler.ics').setValue(settings.icsExportPath).onChange(value => {
			void (async () => {
				settings.icsExportPath = value.trim() || 'AI Scheduler/AI Scheduler.ics';
				await plugin.saveState();
			})();
		}));
	new Setting(containerEl)
		.setName('Days ahead in the file')
		.setDesc('How far into the future the calendar file lists runs (1–366).')
		.addText(text => text.setPlaceholder('30').setValue(String(settings.icsExportDays)).onChange(value => {
			void (async () => {
				const days = Number(value);
				if (!Number.isInteger(days) || days < 1 || days > 366) return;
				settings.icsExportDays = days;
				await plugin.saveState();
			})();
		}))
		.addButton(button => button.setButtonText('Write now').onClick(() => {
			void plugin.exportIcs()
				.then(path => new Notice(`Calendar file written to ${path}.`, 6000))
				.catch(error => new Notice(`Could not export calendar: ${errorText(error)}`, 8000));
		}));
}

function renderLinks(containerEl: HTMLElement, plugin: AISchedulerPlugin, rerender: () => void): void {
	const hub = plugin.calendars;
	new Setting(containerEl).setName(betaName('Calendar links')).setDesc('The easiest way to read events from Google, Outlook, iCloud and most other calendars: paste the calendar\'s private address (.ics). No account or setup needed. Read-only.').setHeading();

	const help = containerEl.createEl('details', { cls: 'ai-scheduler-settings-advanced' });
	help.createEl('summary', { text: 'Where to find the link' });
	renderSteps(help, [
		['Google Calendar: on the web, open Settings → your calendar → Integrate calendar → ', { code: 'Secret address in iCal format' }, '.'],
		['Outlook: on the web, open Settings → Calendar → Shared calendars → Publish a calendar, choose "Can view all details", and copy the ICS link.'],
		['iCloud: in the Calendar app, share the calendar as a Public Calendar and copy the link (it starts with webcal://).'],
		['Others (Fastmail, Proton, Nextcloud…): look for "subscribe", "iCal" or "ICS" in the calendar\'s sharing settings.'],
	]);
	help.createDiv({ cls: 'ai-scheduler-hint', text: 'Treat a private link like a password: anyone with it can read the calendar. You can reset it in your calendar\'s settings. Some work accounts turn these links off.' });
	guideLink(help, LINKS_GUIDE_URL);

	for (const link of hub.links) {
		const row = new Setting(containerEl).setName(link.name).setDesc(hub.linkErrors.get(link.id) ?? new URL(link.url).host);
		if (hub.linkErrors.has(link.id)) row.descEl.addClass('ai-scheduler-status-error');
		row.addExtraButton(button => button.setIcon('trash').setTooltip('Remove this link').onClick(() => {
			hub.removeLink(link.id);
			rerender();
		}));
	}

	let name = '';
	let url = '';
	new Setting(containerEl)
		.setName('Add a calendar link')
		.addText(text => text.setPlaceholder('Name, e.g. Work').onChange(value => { name = value; }))
		.addText(text => {
			text.setPlaceholder('Calendar address (.ics)').onChange(value => { url = value; });
			text.inputEl.addClass('ai-scheduler-link-input');
		})
		.addButton(button => button.setButtonText('Add').setCta().onClick(() => {
			void (async () => {
				button.setDisabled(true);
				try {
					const link = await hub.addLink(name, url);
					new Notice(`Calendar "${link.name}" added.`);
					rerender();
				} catch (error) {
					new Notice(`Could not add the calendar: ${errorText(error)}`, 8000);
					button.setDisabled(false);
				}
			})();
		}));
}

interface AccountTexts {
	title: string;
	intro: string;
	guide: string;
	steps: Step[];
	note: string;
	/** Google clients have a secret; Microsoft desktop apps don't. */
	secret: boolean;
}

function renderAccount(containerEl: HTMLElement, plugin: AISchedulerPlugin, account: CalendarAccount, rerender: () => void, texts: AccountTexts): void {
	const settings = plugin.settings;
	const hub = plugin.calendars;
	const prefix = account.kind;
	new Setting(containerEl).setName(betaName(texts.title)).setDesc(texts.intro).setHeading();

	// Setting up the user's own client: open until they entered one.
	const setup = containerEl.createEl('details', { cls: 'ai-scheduler-settings-advanced' });
	setup.open = !account.available && !account.connected;
	setup.createEl('summary', { text: account.available ? `Your ${account.name} client` : `Set up your ${account.name} client (one time, about 5 minutes)` });
	renderSteps(setup, texts.steps);
	setup.createDiv({ cls: 'ai-scheduler-hint', text: `${texts.note} The client details are saved with the plugin settings, so synced devices share them; each computer still connects on its own.` });
	guideLink(setup, texts.guide);
	new Setting(setup)
		.setName('Client ID')
		.addText(text => text.setValue(account.settings.clientId).onChange(value => {
			void (async () => {
				if (prefix === 'google') settings.googleClientId = value.trim();
				else settings.outlookClientId = value.trim();
				await plugin.saveState();
			})();
		}));
	if (texts.secret) {
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
	}

	const row = new Setting(containerEl).setName(`${account.name} account`);
	if (account.connected) {
		row.setDesc(`Connected${account.email ? ` as ${account.email}` : ''} on this device.`);
		row.addButton(button => button.setButtonText('Disconnect').onClick(() => {
			void (async () => {
				button.setDisabled(true);
				if (account.settings.showRuns) {
					await account.removeRunCalendar().catch(error => new Notice(`Could not delete the AI Scheduler calendar in ${account.name}: ${errorText(error)}`, 8000));
				}
				await account.disconnect();
				if (prefix === 'google') settings.googleShowRuns = false;
				else settings.outlookShowRuns = false;
				hub.forget();
				await plugin.saveState();
				new Notice(`${account.name} calendar disconnected.`);
				rerender();
			})();
		}));
	} else if (Platform.isMobile) {
		row.setDesc(`Connect ${account.name} from Obsidian on a computer. The sign-in needs a desktop browser.`);
	} else {
		row.setDesc(`Enter your client ID above, then connect. ${account.name} opens in your browser; allow access, then come back to Obsidian.`);
		let cancel: AbortController | null = null;
		row.addButton(button => button.setButtonText('Connect').setCta().onClick(() => {
			if (cancel) {
				cancel.abort();
				return;
			}
			cancel = new AbortController();
			button.setButtonText('Cancel');
			row.setDesc(`Waiting for ${account.name} in your browser…`);
			void account.connect(cancel.signal)
				.then(() => {
					hub.forget();
					new Notice(`${account.name} calendar connected${account.email ? ` as ${account.email}` : ''}.`);
				})
				.catch(error => new Notice(errorText(error), 8000))
				.finally(() => {
					cancel = null;
					rerender();
				});
		}));
	}
	if (account.lastError) {
		containerEl.createDiv({ cls: 'ai-scheduler-status-error ai-scheduler-settings-note', text: account.lastError });
	}
	if (!account.connected) return;

	new Setting(containerEl)
		.setName(`Show runs in ${account.name}`)
		.setDesc(`Keeps an "AI Scheduler" calendar in ${account.name} with your upcoming runs, without reminders. Updated from the device that runs scheduled tasks${plugin.runsTasksHere ? ' (this one)' : '; this device does not, so nothing is sent from here'}. Turning it off deletes that calendar.`)
		.addToggle(toggle => toggle.setValue(account.settings.showRuns).onChange(value => {
			void (async () => {
				if (prefix === 'google') settings.googleShowRuns = value;
				else settings.outlookShowRuns = value;
				await plugin.saveState();
				if (value) {
					await hub.syncRuns(true, account)
						.then(() => new Notice(`Runs added to the AI Scheduler calendar in ${account.name}.`))
						.catch(error => new Notice(errorText(error), 8000));
				} else {
					await account.removeRunCalendar().catch(error => new Notice(`Could not delete the AI Scheduler calendar in ${account.name}: ${errorText(error)}`, 8000));
				}
				rerender();
			})();
		}));

	const calendars = new Setting(containerEl)
		.setName('Calendars to read')
		.setDesc('Loading…');
	const list = containerEl.createDiv({ cls: 'ai-scheduler-calendar-checks' });
	void account.listCalendars().then(found => {
		calendars.setDesc('Used for {{today_events}} and the others, and for tasks that run before calendar events. With none chosen, your main calendar is read.');
		const chosen = new Set(account.settings.calendars);
		for (const calendar of found) {
			const item = list.createEl('label', { cls: 'ai-scheduler-check-row' });
			const check = item.createEl('input', { type: 'checkbox' });
			check.checked = chosen.has(calendar.id) || (!chosen.size && calendar.primary);
			if (calendar.color) item.createSpan({ cls: 'ai-scheduler-calendar-dot' }).style.setProperty('--ai-scheduler-dot', calendar.color);
			item.createSpan({ text: calendar.primary ? `${calendar.name} (main)` : calendar.name });
			check.onchange = () => {
				void (async () => {
					const ids = new Set(account.settings.calendars.length ? account.settings.calendars : found.filter(entry => entry.primary).map(entry => entry.id));
					if (check.checked) ids.add(calendar.id);
					else ids.delete(calendar.id);
					if (prefix === 'google') settings.googleCalendars = [...ids];
					else settings.outlookCalendars = [...ids];
					hub.forget();
					await plugin.saveState();
				})();
			};
		}
	}).catch(error => {
		calendars.setDesc(`Could not load your calendars: ${errorText(error)}`);
	});
}
