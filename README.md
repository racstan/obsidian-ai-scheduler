# AI Scheduler

> **An AI scheduler for Obsidian: plans, scheduled work, daily previews, reviews, and notifications.**

AI Scheduler is the autonomy layer for [Claudian](https://github.com/YishenTu/claudian) or [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot). Choose exactly one backend in settings. The selected backend provides the AI agent, model, tools, and vault access; this plugin decides when the agent should wake up, gives it a task, reads the result, creates follow-ups, and writes reports into the vault.

## What It Does

- **AI planning**: describe an outcome in normal language and ask the active backend to turn it into jobs
- **Backend modes**: use Claudian mode or Obsidian Copilot mode, with only one active at a time
- **Model control**: choose separate Claudian models for planning, scheduled tasks, daily previews, and nightly reviews; Copilot uses its active model
- **Scheduled work**: run jobs once, hourly, every N minutes or hours for a bounded number of iterations, every day, every week, or after a vault change
- **Flexible frequency**: create multiple weekday/time rules in one schedule, such as Monday at 02:00 and Saturday at 15:00
- **Task context**: attach a Markdown page or a vault project folder to a task; the current page/project list is refreshed every time the editor opens
- **Per-task results**: save each task's output to its own vault folder instead of one global location
- **Self-talk**: let an AI reply create a small number of future follow-up jobs
- **Daily and nightly reviews**: analyze Markdown context and write timestamped reports to `AI Reviews/YYYY-MM-DD-HHmmss.md`
- **Notifications**: show an Obsidian notice when work completes or fails
- **Startup catch-up**: identify jobs that became due while Obsidian was closed
- **Provider independence**: use whichever provider and model the user configured in the selected backend

## How It Works

1. You open **Ask AI to plan** and describe what you want, for example:

   ```text
   Every evening, review the notes I changed today, summarize my progress,
   identify open loops, and create a report in AI Reviews.
   ```

2. The plugin sends a planning request to the selected backend.
3. The backend returns structured jobs containing prompts and schedules.
4. The plugin stores those jobs in its local Obsidian plugin data.
5. When a job is due, the plugin sends the job prompt through the selected backend.
6. After the AI finishes, the plugin can save the reply, notify you, and schedule follow-up jobs returned in the assistant scheduler format.

The AI is responsible for understanding goals and producing useful work. The plugin is responsible for time, persistence, execution, and notifications.

## Nightly Self-Talk

Enable **Nightly review** in the plugin settings, choose a local time, model, context, and report folder. At that time, the scheduler:

1. Collects the configured review context, such as Markdown files created or modified since the start of the current day
2. Gives their paths to the selected backend and asks the agent to read and analyze them with its vault tools
3. Produces a Markdown report with summary, completed work, important ideas, open loops, and next steps
4. Writes the report to `<report folder>/YYYY-MM-DD-HHmmss.md`

The review is opt-in because it sends the contents of your selected vault files to the provider configured in the active backend.

## Does Obsidian Need To Stay Open?

**Yes.** Obsidian plugins run inside the Obsidian application. This plugin is not a background Windows service, and it cannot execute jobs while Obsidian is completely closed. It also does not require an Obsidian CLI.

When Obsidian is open, the plugin checks jobs approximately every 15 seconds. The selected backend must be installed, enabled, and configured with a working provider. The AI work runs through that backend's live runtime, so the app needs to be running for the provider process and vault tools to be available.

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
- **Hourly**: run every hour, optionally for a fixed number of iterations
- **Interval**: run every N minutes or hours, optionally for a fixed number of iterations
- **Multiple weekday times**: several weekday/time rules in one job
- **Vault event**: react to a Markdown file change, with a cooldown to avoid repeated runs

Settings exposes four independent Claudian model choices: planning, scheduled task execution, daily preview, and nightly review. In Copilot mode, Copilot's active model is used. Editing a task is AI-first: describe the change and the planning backend rewrites and saves the task automatically.

The scheduler settings include a **Refresh models** control that reloads the currently available Claudian models. Each task editor can select pages or project folders for context, choose a result folder, and ask AI to change the schedule, including multiple weekday times or bounded intervals.

Recurring jobs remain enabled after completion. One-time jobs are disabled after they finish or fail. Past jobs remain visible in the scheduler and can be edited, run again, or deleted.

## Requirements

- Obsidian desktop
- Either [Claudian](https://github.com/YishenTu/claudian) or [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) installed and enabled
- At least one working provider/model configured in the selected backend

## Install

### Option 1: BRAT

1. Install **BRAT** from Obsidian community plugins
2. BRAT -> `Add Beta Plugin` -> paste `https://github.com/racstan/obsidian-ai-scheduler`
3. Enable **AI Scheduler**

### Option 2: Manual install

1. Download `main.js` and `manifest.json` from the latest Release
2. Put them in `<your-vault>\\.obsidian\\plugins\\ai-scheduler\\`
3. Enable **AI Scheduler** under Community plugins

The release assets contain the complete installable plugin package.

## Commands

- **Open AI Scheduler**: view scheduled tasks and recent activity
- **Ask AI to plan a schedule**: describe an outcome and let the selected backend generate jobs
- **Run AI daily preview**: generate a timestamped report immediately without blocking the dashboard
- **Run AI nightly review now**: run the nightly review immediately
- **Enable nightly AI review**: enable the recurring self-talk job

## Privacy And Safety

- The plugin does not contain an AI model or provider API key.
- Prompts and vault content are sent wherever Claudian's configured provider sends them.
- Nightly review is disabled by default and must be explicitly enabled.
- Jobs are stored in Obsidian's plugin data directory.
- Recurring AI jobs can consume provider quota, so review generated prompts and disable jobs you do not want.

## License

MIT
