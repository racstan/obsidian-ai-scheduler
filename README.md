# AI Scheduler for Obsidian

<div align="center">

[![Release](https://img.shields.io/github/v/release/racstan/obsidian-ai-scheduler?style=flat-square)](https://github.com/racstan/obsidian-ai-scheduler/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.6%2B-purple.svg?style=flat-square)](https://obsidian.md)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg?style=flat-square)](LICENSE)

</div>

**AI Scheduler** is an Obsidian plugin that runs your AI tasks automatically in the background — on a schedule, at a set time, or when files in your vault change.

Instead of manually opening a chat sidebar every time, you describe what you want once, set a cadence, and the plugin handles execution for you: running periodic vault reviews, summarizing notes, processing project folders, generating reports, and more — while you work or sleep.

It works with the AI plugins you likely already have installed:

- **[Claudian](https://github.com/YishenTu/claudian)**
- **[Oh My Claudian](https://github.com/lee259/oh-my-claudian)**
- **[Copilot](https://github.com/logancyang/obsidian-copilot)**

AI Scheduler does not call AI providers directly. It drives Claudian, Oh My Claudian or Copilot — whichever you have configured — and owns only the scheduling and execution layer.

Supported versions: Claudian 2.x (including the 2.3.2x releases), Oh My Claudian, and Copilot 3.x and 4.x. Claudian's providers (Claude, Codex, OpenCode, Pi and others) and Oh My Claudian's extra providers are supported.

<p align="center">
  <img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/demo.gif" alt="Planning a task in plain English: AI Scheduler creates and schedules it" width="860">
</p>

<p align="center"><em>Describe a task in plain English → AI Scheduler plans it, schedules it and runs it.</em><br>
▶️ <a href="https://github.com/racstan/obsidian-ai-scheduler/raw/main/docs/media/demo.mp4">Watch the full walkthrough (4 min, MP4)</a>: setup guide, settings, planning, calendar, and a task running to a finished note.</p>

---

## What it can do

**Scheduled tasks** — Create jobs that run on any cadence: every morning at 9 AM, every 30 minutes, on specific weekdays, or with a full 5-field cron expression. Set a prompt once and let it run repeatedly.

**Choose where results go** — Each task can save a new note every run, keep one note and replace it, add each run to one note (at the end or under a heading), or add each run to today's daily note.

**Variables in instructions** — Write `{{date}}`, `{{yesterday}}`, `{{last_run}}`, `{{changed_notes}}` (links to the notes changed since the last run), `{{daily_note}}` and more. They are filled in each time the task runs, and also work in result file names and headings.

**Retries, time limits and "only if changed"** — A failed run can be retried automatically after a delay, a run that hangs can be stopped after a time limit, and a task can skip its run when none of the notes it reads changed since its last successful run.

**Run history** — Each task keeps its last 20 runs (time, result, duration, the note it wrote, and any error), shown in the task's details.

**Periodic review** — Daily, weekly, every N days or every N hours, the plugin gathers the notes you changed since the previous review, sends them to your AI backend for analysis, and saves a structured report (key progress, open loops, recommendations) as a Markdown file in your vault.

**Event-driven triggers** — Run a job when a note in your vault is modified or created (the plugin's own output, review and schedule folders are ignored). The job fires at most once per cooldown period you choose, and the AI is told which file changed.

**Natural language planner** — Type a goal like "every Friday afternoon, summarize this week's project notes and write a brief to the AI Reviews folder" and the planner converts it into a properly configured scheduled job.

**Vault-synced schedule notes** — Optionally mirror every task as a Markdown note with YAML frontmatter. Edit the note in Obsidian or edit the dashboard UI — both stay in sync.

**Calendar export** — Keep an `.ics` file of upcoming runs up to date and import it into Google Calendar, Outlook or Apple Calendar (or subscribe to it, if you sync the file somewhere with a public link). One-way: the plugin only writes the file.

**Starter templates** — Daily summary, weekly review, morning plan, inbox triage, action items, flashcards, link suggestions and a monthly reflection. Each opens the task editor pre-filled so you can adjust it before saving.

**Chained tasks** — Make a task run after another one finishes, and pass on its result: collect, then summarize, then file away.

**Pause and quiet hours** — Pause everything for an hour, until tomorrow or until you resume, and set daily quiet hours during which due tasks wait. "Run now" works either way.

**Find and organise tasks** — Tag tasks, then search, filter by tag and sort on the dashboard. Export tasks to a JSON file for backups or another vault, and import them back.

**Prompt preview** — See exactly what a task would send, with variables filled in, before it runs.

**Approval mode** — Turn on *Ask before changing existing notes* for a task, and every change it would make to a note that already exists waits in an **Awaiting approval** list on the dashboard: adding its result to a note, replacing its result note, and edits the AI proposes. Each change shows as a diff that you approve or reject. New notes are still created right away. The AI is asked to propose edits instead of making them; if your AI backend edits a note itself anyway, the run history says so.

**Works with other plugins** — Use a [Dataview](https://github.com/blacksmithgu/obsidian-dataview) query in a task's instructions, e.g. `{{dataview: LIST FROM #project WHERE !completed}}`, and its result is filled in when the task runs. Have action items written as task checkboxes (`- [ ] …`, with dates in the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin format and an optional tag). Start result notes from a template note: put `{{result}}` where the result goes, and [Templater](https://github.com/SilentVoid13/Templater) commands in it run when Templater is installed. All three are optional; nothing is needed unless you use them.

**Mobile** — On phones and tablets you can view, edit and plan tasks. Claudian and Oh My Claudian work only on desktop, so tasks run on your computer; with Copilot you can also run tasks by hand on mobile. A per-device setting, *Run scheduled tasks on this device*, decides which device starts scheduled tasks, so a vault synced between devices runs each task once (phones and tablets start with it off).

**Trash & restore** — Deleted tasks go to a trash section. You can restore them individually, restore all at once, or permanently delete them.

---

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/dashboard.png" alt="Dashboard with backend status, task counters and disabled tasks"><br><sub><b>Dashboard</b>: backend status with a shortcut to its settings, task counts, and every task in one place.</sub></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/planner.png" alt="AI planner with a highlighted folder link and attached context"><br><sub><b>AI planner</b>: describe the task in plain English; <code>@</code> attaches notes or folders, shown as highlighted links.</sub></td>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/task-details.png" alt="Task details with status, schedule, created files and prompt"><br><sub><b>Task details</b>: status, schedule, the files it created, and the full prompt.</sub></td>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/task-editor.png" alt="Task editor with manual and AI editing modes"><br><sub><b>Task editor</b>: edit the prompt and schedule yourself, or ask the AI to rewrite them.</sub></td>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/dashboard-tasks.png" alt="Past tasks and recent activity"><br><sub><b>History</b>: past runs with view / run again, and a recent-activity log.</sub></td>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/settings-backend.png" alt="Settings: AI backend and models"><br><sub><b>Settings</b>: pick the backend and the model for each kind of work.</sub></td>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/settings-reviews.png" alt="Settings: periodic reviews and task outputs"><br><sub><b>Periodic reviews and outputs</b>: recurring vault summaries and where results are saved.</sub></td>
    <td><img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/settings-calendar-export.png" alt="Settings: calendar export and notifications"><br><sub><b>Calendar export and notifications</b>: an <code>.ics</code> feed of upcoming runs, plus in-app and desktop notices.</sub></td>
  </tr>
</table>

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
| **Vault event** | Runs when any note in the vault is modified or created (with a cooldown) |
| **After another task** | Runs each time a chosen task finishes successfully; use `{{previous_result}}` or `{{previous_output}}` to work with that task's result |

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

AI Scheduler needs one of these backends installed and working first. Install it from the community plugin store, then set up your providers and models in its own settings:

- **[Claudian](https://github.com/YishenTu/claudian)**
- **[Oh My Claudian](https://github.com/lee259/oh-my-claudian)**
- **[Copilot](https://github.com/logancyang/obsidian-copilot)**

Then in **Settings → AI Scheduler**:

1. Pick your **AI backend** (Claudian, Oh My Claudian or Copilot).
2. Choose models for **Planning model**, **Scheduled task model**, **Daily preview model** and **Periodic review model**.
3. Optionally enable **Schedule notes** to mirror tasks as vault Markdown files.
4. Optionally enable **Periodic AI review**, choose its cadence and time, and pick a review folder.

On first install the plugin creates a short **AI Scheduler - Getting started** note with these steps; reopen it any time with **AI Scheduler: Open getting started guide** or from **Settings → AI Scheduler → Help & community**. The dashboard, planner and AI task editor have a button to open your backend's settings (for example **Claudian settings**), and show what to fix if the backend isn't installed, enabled or set up.

<p align="center">
  <img src="https://raw.githubusercontent.com/racstan/obsidian-ai-scheduler/main/docs/media/settings-notes-help.png" alt="Settings: schedule notes, release notes and the getting started guide" width="640">
</p>

---

## Dashboard

Click the brain icon in the ribbon or run **AI Scheduler: Open assistant dashboard** from the command palette.

The dashboard shows:
- All scheduled tasks with their next run time and status
- Running tasks with a live elapsed timer
- Recently completed tasks and their output
- Disabled and deleted (trash) tasks
- Recent activity log

From here you can create tasks (yourself, from a template, or with the AI Planner), edit them, run them on demand, pause, and restore from trash.

- **Search, tags and sorting**: the bar above the task lists searches titles, instructions, tags and task numbers (`#7`), filters by tag and sorts by next run, title, task number or last run.
- **Pause…**: pause for 1 hour, 4 hours, until tomorrow 08:00, or until you resume. While paused, no task starts on its own; "Run now" still works. On resume, runs missed while paused follow the **Run missed jobs after startup** setting, as if Obsidian had been closed.
- **More…**: export tasks to a JSON file, or import tasks from one. Imported tasks are added paused so you can review them first; run history and replies are not included.

**Quiet hours** (Settings → Background execution): tasks that fall due in that window wait and run once it ends. The status bar shows the next run, or that AI Scheduler is paused or in quiet hours (this can be turned off).

### Task options

In the task editor:

- **Save results**:
  - *A new note each run*: the default. A file name is optional.
  - *Replace one note each run*: the note always holds the latest result.
  - *Add to one note*: each run is added at the end of the note, or under a heading you name. A missing heading is created.
  - *Add to today's daily note*: uses the folder, date format and template of the Daily notes core plugin.
- **Variables**: click *Variables you can use* under the instructions to insert one.

  | Variable | Filled in with |
  | --- | --- |
  | `{{date}}`, `{{time}}` | today's date and the current time |
  | `{{yesterday}}`, `{{tomorrow}}` | those dates |
  | `{{weekday}}`, `{{week}}`, `{{month}}` | e.g. Monday, 2026-W42, 2026-10 |
  | `{{date:DD MMM YYYY}}` | today in your own format |
  | `{{last_run}}` | when the task last ran successfully |
  | `{{changed_notes}}` | links to the notes changed since the last run (up to 50) |
  | `{{daily_note}}` | a link to today's daily note |
  | `{{task}}` | the task title |

  Any other `{{...}}` (for example Templater syntax) is left untouched.
- **Run options**:
  - *Retries*: up to 5, with the minutes to wait between them.
  - *Time limit*: stops a run that takes longer than this.
  - *Only run when something changed*: skips the run when none of the attached notes or folders changed since the last successful run. With nothing attached, any note in the vault counts. Results the plugin wrote itself never count.

- **Tags**: comma-separated labels. Click a tag on the dashboard to show only those tasks.

A task's details show its **run history**: completed, failed, skipped and cancelled runs, with links to the notes they wrote. For a failed task the button reads **Retry now**.

## Schedule calendar

Run **AI Scheduler: Open schedule calendar** to see every task's runs in a month grid, an agenda list, or a full-page day view with a timeline. Past runs show as completed only when the task actually ran; you can create, run, pause and resume tasks directly from the calendar.

### See your AI tasks in Google Calendar, Outlook or Apple Calendar

Turn on **Settings → AI Scheduler → Calendar export**. The plugin then keeps an `.ics` file (by default `AI Scheduler/AI Scheduler.ics`) listing your upcoming runs, and rewrites it whenever your tasks change. There are two ways to use it:

**Import (one-time snapshot).** Import the file in your calendar app (Google Calendar: *Settings → Import & export*). This copies the runs listed at that moment; later changes need another import.

**Subscribe (stays up to date).** Calendar apps can follow a calendar from a web address and re-download it periodically. The plugin itself never uploads anything — you give the file a public link with whatever already syncs your vault:

1. Make sure the `.ics` file is synced to a service that can share a *direct download* link — for example the Dropbox desktop app, or a plugin such as Remotely Save syncing to Dropbox. (Change the end of a Dropbox share link from `?dl=0` to `?dl=1`.) Sync services without public links (Obsidian Sync, iCloud, Syncthing) can't be used for this, and OneDrive / Google Drive share links usually open a web page rather than the file.
2. Subscribe to that link:
   - **Google Calendar:** *Other calendars → + → From URL*
   - **Outlook:** *Add calendar → Subscribe from web*
   - **Apple Calendar:** *File → New Calendar Subscription*

Good to know:
- **Updates aren't instant.** Your calendar app decides when to re-download the file; Google can take several hours to a day. Outlook and Apple usually refresh sooner.
- **Anyone with the link can read the file**, which includes task titles and prompts. Treat the link like a password and don't share it.
- **One-way.** Events edited or deleted in your calendar app don't change your tasks.

---

## Commands

All commands are available from the command palette (`Ctrl/Cmd + P`):

| Command | What it does |
| --- | --- |
| `Open assistant dashboard` | Opens the scheduling dashboard |
| `Open schedule calendar` | Opens the month / agenda / day calendar of upcoming runs |
| `Ask AI to plan a schedule` | Opens the natural language planner |
| `Run AI daily preview` | Runs today's preview report immediately |
| `Run AI periodic review now` | Runs the periodic review immediately |
| `Enable periodic AI review` | Turns on recurring periodic reviews |
| `Disable periodic AI review` | Turns off recurring periodic reviews |
| `Toggle periodic AI review` | Toggles the periodic review on/off |
| `Enable all scheduled tasks` | Turns all disabled tasks back on (one-time tasks whose time has passed stay off) |
| `Disable all scheduled tasks` | Turns all tasks off |
| `Restore last deleted task` | Restores the most recently deleted task |
| `Sync schedule notes now` | Reconciles vault notes with active schedules |
| `Export schedule to calendar file (.ics)` | Writes upcoming runs to the calendar file |
| `Open getting started guide` | Opens (or recreates) the setup guide note |
| `New task from a template` | Opens the starter templates |
| `Pause all tasks` | Stops tasks from starting on their own until you resume |
| `Resume all tasks` | Ends a pause |
| `Export tasks to a file` | Writes all tasks to a JSON file in the result folder |
| `Import tasks from a file` | Adds the tasks from an export file, paused for review |
| `View changelog / what's new` | Opens the release history |

---

## Privacy

- No third-party servers, no telemetry, no analytics.
- Prompts and vault files go only to your configured backend (Claudian, Oh My Claudian or Copilot) and then to whatever AI provider you have set up there.
- Periodic reviews and automated note reading are opt-in.
- Follow-up tasks that the AI proposes in its replies are created **disabled** — you review and enable them yourself.
- Task output is written as Markdown notes. The plugin never replaces a note it did not create; it only adds to an existing note when you choose **Add to one note** or **Add to today's daily note** for that task. It never writes into hidden or `.obsidian` folders.
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

## Support

AI Scheduler is free and developed in my spare time. If it saves you time and you'd like to support its continued development, you can [buy me a coffee](https://buymeacoffee.com/rachitasthana). Thank you!

---

## Credits

Thanks to the authors of the AI plugins that AI Scheduler works with:

- **[Claudian](https://github.com/YishenTu/claudian)** by [Yishen Tu](https://github.com/YishenTu)
- **[Oh My Claudian](https://github.com/lee259/oh-my-claudian)** by [Lee](https://github.com/lee259)
- **[Copilot](https://github.com/logancyang/obsidian-copilot)** by [Logan Yang](https://github.com/logancyang)

Each plugin is developed and licensed by its own author; AI Scheduler is not affiliated with them.

Thanks also to everyone who contributed code, reported issues or suggested features. They are credited in each release of the [changelog](CHANGELOG.md) and in the plugin's **What's new** window.

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 [racstan](https://github.com/racstan).

This plugin is licensed under the PolyForm Noncommercial License 1.0.0 for noncommercial and personal use.

