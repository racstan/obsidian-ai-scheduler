/*
 * The "Getting started" note: created once on a fresh install (and on demand
 * from the command / settings), so new users see the setup order — a backend
 * plugin first, its own provider setup second, AI Scheduler third.
 */
export const GETTING_STARTED_PATH = 'AI Scheduler - Getting started.md';

export function gettingStartedNote(): string {
	return `# Welcome to AI Scheduler 👋

AI Scheduler runs AI tasks for you in the background: on a schedule, at a set time, when notes change, or as regular reviews of your vault. The results are saved as notes.

> [!important] AI Scheduler needs an AI backend
> AI Scheduler does not connect to AI providers itself. It hands your tasks to **Claudian** or **Obsidian Copilot**, which use the providers, API keys and models you set up in *their* settings. Without one of them installed, enabled and set up, nothing can run.

## 1. Install a backend

Pick one (you can switch later):

- **Claudian**: [Open in Community plugins](obsidian://show-plugin?id=realclaudian)
- **Obsidian Copilot**: [Open in Community plugins](obsidian://show-plugin?id=copilot)

Then enable it: **Settings → Community plugins**, and turn it on.

## 2. Set it up in its own settings

Open the backend's settings (**Settings → Claudian** or **Settings → Copilot**) and connect your provider: add your API key or sign in, and choose your models. Send it one chat message to check it works.

AI Scheduler has no settings for providers or keys. It simply uses what you configure in the backend.

## 3. Connect AI Scheduler

In **Settings → AI Scheduler**:

1. **AI backend**: choose Claudian or Obsidian Copilot.
2. **Models** (Claudian): pick the models for planning, scheduled tasks and reviews. If the list is empty, finish step 2 and refresh it.

The AI Scheduler dashboard shows whether the backend is ready, with a button to open its settings.

## 4. Create your first task

Open the dashboard with the ribbon icon or the command **AI Scheduler: Open assistant dashboard**, then either:

- **Ask AI to plan a schedule**: describe what you want in plain English, for example *"Every weekday at 9 am, summarize the notes I changed yesterday"*. Type \`@\` to attach notes or folders, and optionally pick a **Result folder**.
- **Create a task yourself**: write the instructions and choose a schedule (once, daily, weekly, every N minutes, cron, or when notes change).

Results are saved as new notes in the result folder (**AI Scheduler** by default).

## 5. Optional extras

- **Periodic review**: a daily or weekly summary of what changed in your vault.
- **Schedule calendar**: all upcoming runs at a glance (**AI Scheduler: Open schedule calendar**).
- **Calendar export**: an \`.ics\` file for Google Calendar, Outlook or Apple Calendar.
- **Schedule notes**: keep each task as a note you can edit.

## Good to know

- Obsidian has to be open for tasks to run. Runs missed while it was closed can be caught up on startup (a setting).
- Tasks that the AI suggests in its replies are created **disabled** until you turn them on.
- If something goes wrong, the notice shows the backend's own error message, for example a model that isn't available.

You can delete this note at any time. Reopen it with **AI Scheduler: Open getting started guide**.
`;
}
