# AI Scheduler

> **An autonomous AI assistant for Obsidian: schedules, self-talk, vault reviews, and notifications.**

AI Scheduler is the autonomy layer for [Claudian](https://github.com/YishenTu/claudian). Claudian provides the AI agent, selected provider, model, tools, and vault access. This plugin decides when the agent should wake up, gives it a task, reads the result, creates follow-ups, and writes reports into the vault.

## What It Does

- **AI planning**: describe an outcome in normal language, choose a Claudian provider/model, and ask the AI to turn it into jobs
- **Scheduled work**: run jobs once, every day, every week, or after a vault change
- **Self-talk**: let an AI reply create a small number of future follow-up jobs
- **Nightly review**: analyze Markdown files changed during the day and write a report to `AI Reviews/YYYY-MM-DD.md`
- **Notifications**: show an Obsidian notice when work completes or fails
- **Startup catch-up**: identify jobs that became due while Obsidian was closed
- **Provider independence**: use whichever provider and model the user configured in Claudian

## How It Works

1. You open **Ask AI to plan** and describe what you want, for example:

   ```text
   Every evening, review the notes I changed today, summarize my progress,
   identify open loops, and create a report in AI Reviews.
   ```

2. The plugin sends a planning request to a Claudian chat.
3. Claudian returns structured jobs containing prompts and schedules.
4. The plugin stores those jobs in its local Obsidian plugin data.
5. When a job is due, the plugin switches to the configured Claudian chat and sends the job prompt.
6. After the AI finishes, the plugin can save the reply, notify you, and schedule follow-up jobs returned in the assistant scheduler format.

The AI is responsible for understanding goals and producing useful work. The plugin is responsible for time, persistence, execution, and notifications.

## Nightly Self-Talk

Enable **Nightly review** in the plugin settings, choose a local time, and choose a report folder. At that time, the assistant:

1. Finds Markdown files created or modified since the start of the current day
2. Gives their paths to Claudian and asks the agent to read and analyze them with its vault tools
3. Produces a Markdown report with summary, completed work, important ideas, open loops, and next steps
4. Writes the report to `<report folder>/YYYY-MM-DD.md`

The review is opt-in because it sends the contents of your selected vault files to the provider configured in Claudian.

## Does Obsidian Need To Stay Open?

**Yes.** Obsidian plugins run inside the Obsidian application. This plugin is not a background Windows service, and it cannot execute jobs while Obsidian is completely closed. It also does not require an Obsidian CLI.

When Obsidian is open, the plugin checks jobs approximately every 15 seconds. Claudian must also be installed, enabled, and configured with a working provider. The AI work runs through Claudian's live chat runtime, so the app needs to be running for the provider process and vault tools to be available.

If Obsidian is closed when a job becomes due:

- The job does not run in the background.
- On the next launch, the plugin can catch up jobs missed within the configured startup window, but this is **disabled by default**.
- Jobs missed outside that window are left alone rather than unexpectedly running very old work.
- You can disable catch-up in Settings.

For unattended use, configure your operating system to launch Obsidian when you sign in and leave it minimized. A future standalone daemon could run without Obsidian, but it would need to reimplement provider authentication, agent tools, vault access, permissions, and session handling instead of using Claudian.

## Job Types

The AI planner can create these schedules:

- **Once**: a specific ISO-8601 date and time
- **Daily**: a local time such as `22:00`
- **Weekly**: a local time and selected weekdays
- **Vault event**: react to a Markdown file change, with a cooldown to avoid repeated runs

The planning dialog shows provider/model profiles discovered from Claudian's open chats and saved model selections. The selected profile is stored with generated jobs, so a scheduled job continues using the intended Claudian conversation and model.

Recurring jobs remain enabled after completion. One-time jobs are disabled after they finish or fail. Failed jobs are visible in the assistant panel and can be retried.

## Requirements

- Obsidian desktop
- [Claudian](https://github.com/YishenTu/claudian) installed and enabled
- At least one working provider/model configured in Claudian

## Install

### Option 1: BRAT

1. Install **BRAT** from Obsidian community plugins
2. BRAT -> `Add Beta Plugin` -> paste `https://github.com/racstan/obsidian-ai-scheduler`
3. Enable **AI Scheduler**

### Option 2: Manual install

1. Download `main.js` and `manifest.json` from the latest Release
2. Put them in `<your-vault>\\.obsidian\\plugins\\ai-scheduler\\`
3. Enable **AI Scheduler** under Community plugins

## Commands

- **Open AI assistant**: view active jobs and recent activity
- **Ask AI to plan a schedule**: describe an outcome and let Claudian generate jobs
- **Run AI daily review now**: generate today's report immediately
- **Enable nightly AI review**: enable the recurring self-talk job

## Privacy And Safety

- The plugin does not contain an AI model or provider API key.
- Prompts and vault content are sent wherever Claudian's configured provider sends them.
- Nightly review is disabled by default and must be explicitly enabled.
- Jobs are stored in Obsidian's plugin data directory.
- Recurring AI jobs can consume provider quota, so review generated prompts and disable jobs you do not want.

## License

MIT
