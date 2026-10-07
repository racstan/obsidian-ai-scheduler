# AI Scheduler for Obsidian

<div align="center">

[![Release](https://img.shields.io/github/v/release/racstan/obsidian-ai-scheduler?style=flat-square)](https://github.com/racstan/obsidian-ai-scheduler/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.6%2B-purple.svg?style=flat-square)](https://obsidian.md)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg?style=flat-square)](LICENSE)

</div>

**AI Scheduler** is an Obsidian plugin that runs your AI tasks automatically in the background — on a schedule, at a set time, or when files in your vault change.

Instead of manually opening a chat sidebar every time, you describe what you want once, set a cadence, and the plugin handles execution for you: running nightly reviews, summarizing notes, processing project folders, generating reports, and more — while you work or sleep.

It works with two backends you likely already have installed:

- **[Claudian](https://github.com/YishenTu/claudian)** — for Claude (Anthropic) models with deep tool use
- **[Obsidian Copilot](https://github.com/logancyang/obsidian-copilot)** — for OpenAI, Gemini, local Ollama, and more

AI Scheduler does not call AI providers directly. It drives Claudian or Copilot — whichever you have configured — and owns only the scheduling and execution layer.

---

## What it can do

**Scheduled tasks** — Create jobs that run on any cadence: every morning at 9 AM, every 30 minutes, on specific weekdays, or with a full 5-field cron expression. Set a prompt once and let it run repeatedly.

**Nightly review** — At your chosen time, the plugin automatically gathers today's modified notes, sends them to your AI backend for analysis, and saves a structured report (key progress, open loops, recommendations) as a Markdown file in your vault.

**Event-driven triggers** — Watch a folder or note for changes. When files are modified, the scheduler fires the job automatically after a cooldown period you choose.

**Natural language planner** — Type a goal like "every Friday afternoon, summarize this week's project notes and write a brief to the AI Reviews folder" and the planner converts it into a properly configured scheduled job.

**Vault-synced schedule notes** — Optionally mirror every task as a Markdown note with YAML frontmatter. Edit the note in Obsidian or edit the dashboard UI — both stay in sync.

**Trash & restore** — Deleted tasks go to a trash section. You can restore them individually, restore all at once, or permanently delete them.

---

## Supported schedule types

| Type | What it does |
| --- | --- |
| **Daily** | Runs every day at a set time (`22:00`) |
| **Weekly** | Runs on chosen weekdays at a set time |
| **Every N days / weeks / months / yearly** | Extended recurring cadences |
| **Interval** | Runs every N minutes or hours |
| **Cron** | Full 5-field cron expression (`0 9 * * 1-5`) |
| **Multi-rule** | Multiple weekday + time combinations in one job |
| **Once** | Runs once at a specific future date and time |
| **Vault event** | Runs when files in a watched folder change |

All schedule types support an optional **max iterations** limit — the job stops automatically after N runs.

---

## Installation

**From the Obsidian Community Plugin store (recommended):**

1. Open Obsidian **Settings → Community plugins**.
2. Turn **Restricted mode** off if it is on.
3. Click **Browse**, search for **AI Scheduler**, and install it.

**Manual installation:**

1. Download the [latest release](https://github.com/racstan/obsidian-ai-scheduler/releases): `main.js`, `manifest.json`, `styles.css`.
2. Create the folder `.obsidian/plugins/ai-scheduler/` inside your vault.
3. Copy the three files into that folder.
4. In **Settings → Community plugins**, reload plugins and enable **AI Scheduler**.

---

## Setup

AI Scheduler needs one of these backends installed and working first:

- **[Claudian](https://github.com/YishenTu/claudian)** — install from the community plugin store, configure your Anthropic API key inside Claudian.
- **[Obsidian Copilot](https://github.com/logancyang/obsidian-copilot)** — install from the community plugin store, configure your provider (OpenAI, Gemini, Ollama, etc.) inside Copilot.

Then in **Settings → AI Scheduler**:

1. Pick your **Active backend** (Claudian or Obsidian Copilot).
2. Choose model profiles for Planning, Task Execution, and Nightly Review.
3. Optionally enable **Schedule notes** to mirror tasks as vault Markdown files.
4. Optionally enable **Nightly review**, set a time, and pick a report output folder.

---

## Dashboard

Click the brain icon in the ribbon or run **AI Scheduler: Open assistant dashboard** from the command palette.

The dashboard shows:
- All scheduled tasks with their next run time and status
- Running tasks with a live elapsed timer
- Recently completed tasks and their output
- Disabled and deleted (trash) tasks
- Recent activity log

From here you can create tasks, edit them, run them on demand, pause, restore from trash, or open the AI Planner.

---

## Commands

All commands are available from the command palette (`Ctrl/Cmd + P`):

| Command | What it does |
| --- | --- |
| `Open assistant dashboard` | Opens the scheduling dashboard |
| `Ask AI to plan a schedule` | Opens the natural language planner |
| `Run AI daily preview` | Runs today's preview report immediately |
| `Run AI nightly review now` | Runs the nightly review immediately |
| `Enable nightly AI review` | Turns on recurring nightly reviews |
| `Disable nightly AI review` | Turns off recurring nightly reviews |
| `Toggle nightly AI review` | Toggles nightly review on/off |
| `Enable all scheduled tasks` | Resumes all paused tasks |
| `Disable all scheduled tasks` | Pauses all tasks |
| `Restore last deleted task` | Restores the most recently deleted task |
| `Sync schedule notes now` | Reconciles vault notes with active schedules |
| `View changelog / what's new` | Opens the release history |

---

## Privacy

- No third-party servers, no telemetry, no analytics.
- Prompts and vault files go only to your configured backend (Claudian or Copilot) and then to whatever AI provider you have set up there.
- Nightly reviews and automated note reading are opt-in.
- You control iteration limits and can pause or delete any task at any time.

---

## How it works internally

The plugin runs a lightweight dispatcher every 15 seconds. When a job becomes due, it sends the configured prompt (with any attached context files) to the active backend plugin. The backend executes the AI agent, and results are written to a vault folder you choose. Recurring jobs are rescheduled automatically; one-time jobs are marked complete.

The cron engine is dependency-free and bundled directly — no external packages, DST-safe, and tested against a full suite of edge cases.

---

## Development

```bash
git clone https://github.com/racstan/obsidian-ai-scheduler.git
cd obsidian-ai-scheduler
npm install

npm test        # unit tests (cron engine, schedule math, engine logic)
npm run lint    # ESLint with obsidian-community-plugin ruleset
npm run check   # TypeScript typecheck
npm run smoke   # smoke test against mock Obsidian API
npm run build   # production bundle
```

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 [racstan](https://github.com/racstan).

This plugin is licensed under the PolyForm Noncommercial License 1.0.0 for noncommercial and personal use.

