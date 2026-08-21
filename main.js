/*
 * AI Scheduler - an autonomy layer for Claudian.
 *
 * This plugin deliberately does not call an AI provider directly. Claudian owns
 * providers, models, permissions, and vault tools; this plugin owns when the
 * agent should wake up and what should happen after it replies.
 */
const { Plugin, PluginSettingTab, Modal, Setting, Notice, normalizePath } = require('obsidian');

const TICK_MS = 15000;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SETTINGS = {
  assistantTab: 1,
  reportFolder: 'AI Reviews',
  reviewTime: '22:00',
  nightlyReviewEnabled: false,
  notifyOnCompletion: true,
  catchUpOnStart: true,
  catchUpHours: 24,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(error) {
  return String(error && error.message || error);
}

function localDateKey(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function parseClock(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 22, minute: 0 };
}

function nextDailyRun(time, from = new Date()) {
  const clock = parseClock(time);
  const candidate = new Date(from);
  candidate.setHours(clock.hour, clock.minute, 0, 0);
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

function nextWeeklyRun(time, days, from = new Date()) {
  const clock = parseClock(time);
  const wanted = Array.isArray(days) && days.length ? days.map(Number) : [from.getDay()];
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(clock.hour, clock.minute, 0, 0);
    if (wanted.includes(candidate.getDay()) && candidate > from) return candidate.toISOString();
  }
  return nextDailyRun(time, from);
}

function getScheduleNextRun(schedule, from = new Date()) {
  if (!schedule || schedule.kind === 'event') return null;
  if (schedule.kind === 'once') {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (schedule.kind === 'weekly') return nextWeeklyRun(schedule.time, schedule.days, from);
  return nextDailyRun(schedule.time, from);
}

function contentFromMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(part => typeof part === 'string' ? part : part && part.text || '').join('');
  }
  return '';
}

function extractJson(text) {
  const source = String(text || '').trim();
  const candidates = [];
  const marked = /<assistant-scheduler>\s*([\s\S]*?)\s*<\/assistant-scheduler>/i.exec(source);
  if (marked) candidates.push(marked[1]);
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(source);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(source);
  const start = Math.min(...candidates.map(value => {
    const a = value.indexOf('[');
    const o = value.indexOf('{');
    return a < 0 ? o : o < 0 ? a : Math.min(a, o);
  }).filter(value => value >= 0));
  if (Number.isFinite(start) && start >= 0) {
    for (const value of candidates) {
      const trimmed = value.trim();
      for (let end = trimmed.length; end > start; end--) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end));
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (_) { /* keep looking for the end of the JSON value */ }
      }
    }
  }
  return [];
}

function normalizeJob(raw, now = new Date()) {
  const schedule = raw.schedule || (raw.sendAt ? { kind: 'once', at: raw.sendAt } : { kind: 'once', at: new Date(Date.now() + 60000).toISOString() });
  const normalizedSchedule = {
    kind: ['once', 'daily', 'weekly', 'event'].includes(schedule.kind) ? schedule.kind : 'once',
    at: schedule.at,
    time: schedule.time,
    days: schedule.days,
    event: schedule.event,
  };
  const nextRunAt = raw.nextRunAt !== undefined
    ? raw.nextRunAt
    : getScheduleNextRun(normalizedSchedule, now);
  return Object.assign({
    id: id('job'),
    title: 'Assistant task',
    prompt: '',
    tab: 1,
    enabled: true,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastReply: '',
    lastError: null,
    routine: null,
    notify: true,
    output: null,
    attempts: 0,
  }, raw, { schedule: normalizedSchedule, nextRunAt });
}

function describeSchedule(job) {
  const schedule = job.schedule || {};
  if (schedule.kind === 'daily') return `daily at ${schedule.time}`;
  if (schedule.kind === 'weekly') return `weekly at ${schedule.time}`;
  if (schedule.kind === 'event') return `when ${schedule.event || 'the vault changes'}`;
  return job.nextRunAt ? formatDate(job.nextRunAt) : 'not scheduled';
}

module.exports = class AISchedulerPlugin extends Plugin {
  async onload() {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.jobs = Array.isArray(data.jobs)
      ? data.jobs.map(job => normalizeJob(job))
      : (Array.isArray(data.tasks) ? data.tasks.map(task => normalizeJob({
        ...task,
        title: task.title || 'Migrated task',
        prompt: task.prompt || task.content || '',
        schedule: { kind: 'once', at: task.sendAt },
        enabled: task.status === 'pending',
      })) : []);
    this.activity = Array.isArray(data.activity) ? data.activity.slice(-50) : [];
    this.running = false;
    this.lastTickError = null;

    this.addRibbonIcon('brain', 'Open AI assistant', () => new AssistantModal(this.app, this).open());
    this.addCommand({
      id: 'open-assistant',
      name: 'Open AI assistant',
      callback: () => new AssistantModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'plan-with-ai',
      name: 'Ask AI to plan a schedule',
      callback: () => new PlannerModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'run-daily-review',
      name: 'Run AI daily review now',
      callback: () => this.runDailyReview(true),
    });
    this.addCommand({
      id: 'enable-nightly-review',
      name: 'Enable nightly AI review',
      callback: async () => {
        this.settings.nightlyReviewEnabled = true;
        await this.ensureNightlyReviewJob();
        await this.saveState();
        new Notice('Nightly AI review enabled');
      },
    });
    this.addSettingTab(new AssistantSettingTab(this.app, this));

    this.registerInterval(window.setInterval(() => { void this.tick(); }, TICK_MS));
    this.registerEvent(this.app.vault.on('modify', file => { void this.handleVaultChange(file); }));
    this.registerEvent(this.app.vault.on('create', file => { void this.handleVaultChange(file); }));

    if (this.settings.nightlyReviewEnabled) await this.ensureNightlyReviewJob();
    await this.saveState();
    await this.catchUpOnStart();
    console.log('[ai-scheduler] autonomous assistant loaded, jobs:', this.jobs.length);
  }

  async saveState() {
    await this.saveData({ version: 2, settings: this.settings, jobs: this.jobs, activity: this.activity.slice(-50) });
  }

  logActivity(type, message, jobId = null) {
    this.activity.push({ id: id('event'), at: new Date().toISOString(), type, message, jobId });
    this.activity = this.activity.slice(-50);
  }

  async catchUpOnStart() {
    const now = Date.now();
    const due = this.jobs.filter(job => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now);
    if (!this.settings.catchUpOnStart) {
      for (const job of due) this.skipMissedJob(job);
      if (due.length) await this.saveState();
      return;
    }
    const cutoff = now - Number(this.settings.catchUpHours || 24) * 60 * 60 * 1000;
    const missed = due.filter(job => new Date(job.nextRunAt).getTime() >= cutoff);
    const stale = due.filter(job => new Date(job.nextRunAt).getTime() < cutoff);
    for (const job of stale) this.skipMissedJob(job);
    if (missed.length || stale.length) {
      if (missed.length) {
        this.logActivity('startup', `Found ${missed.length} task(s) due while Obsidian was closed`);
      }
      await this.saveState();
    }
    if (missed.length) {
      new Notice(`${missed.length} AI task(s) are ready after startup`, 6000);
    }
    await this.tick();
  }

  skipMissedJob(job) {
    if (job.schedule.kind === 'once') {
      job.enabled = false;
      job.nextRunAt = null;
      job.status = 'missed';
      job.lastStatus = 'missed';
      this.logActivity('missed', `${job.title} was not run during startup catch-up`, job.id);
    } else if (job.schedule.kind === 'event') {
      job.nextRunAt = null;
    } else {
      job.nextRunAt = getScheduleNextRun(job.schedule, new Date());
    }
  }

  getClaudianPlugin() {
    return this.app.plugins && this.app.plugins.plugins ? this.app.plugins.plugins.claudian : null;
  }

  async getClaudianView() {
    const claudian = this.getClaudianPlugin();
    if (!claudian) return null;
    let views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
    if (!views.length && typeof claudian.activateView === 'function') {
      try { await claudian.activateView(); } catch (_) { /* Claudian may already be opening */ }
      await sleep(1200);
      views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
    }
    return views[0] || null;
  }

  getTab(view, number) {
    if (!view || !view.tabManager) return null;
    const manager = view.tabManager;
    const items = typeof manager.getTabBarItems === 'function' ? manager.getTabBarItems() : [];
    const item = items[Math.max(0, Number(number || 1) - 1)];
    if (!item) return null;
    const tabs = typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
    return tabs.find(tab => tab.id === item.id) || manager.getActiveTab && manager.getActiveTab();
  }

  tabIsBusy(view, tab) {
    if (!tab) return false;
    const item = view.tabManager.getTabBarItems().find(candidate => candidate.id === tab.id);
    return Boolean(tab.state && tab.state.isStreaming || tab.isStreaming || item && (item.isWorking || item.isStreaming));
  }

  async waitForTabIdle(view, tab) {
    const started = Date.now();
    while (this.tabIsBusy(view, tab)) {
      if (Date.now() - started > AGENT_TIMEOUT_MS) throw new Error('Claudian chat stayed busy for 30 minutes');
      await sleep(1000);
    }
  }

  getTabMessages(view, tab) {
    const direct = tab && tab.state && Array.isArray(tab.state.messages) ? tab.state.messages : [];
    if (direct.length) return direct;
    const conversationId = tab && tab.conversationId;
    const conversation = conversationId && this.getClaudianPlugin()
      && this.getClaudianPlugin().getConversationSync
      ? this.getClaudianPlugin().getConversationSync(conversationId) : null;
    return conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  }

  lastAssistantReply(view, tab, beforeCount) {
    const messages = this.getTabMessages(view, tab);
    const candidates = messages.slice(Math.max(0, beforeCount)).filter(message => message.role === 'assistant');
    const fallback = messages.filter(message => message.role === 'assistant');
    const messagesToUse = candidates.length ? candidates : fallback;
    const message = messagesToUse[messagesToUse.length - 1];
    return contentFromMessage(message).trim();
  }

  async sendToClaudian(prompt, tabNumber = this.settings.assistantTab) {
    const view = await this.getClaudianView();
    if (!view || !view.tabManager) throw new Error('Claudian is not available. Open or enable Claudian first.');
    const manager = view.tabManager;
    const target = this.getTab(view, tabNumber);
    if (!target) throw new Error(`Claudian chat ${tabNumber} does not exist.`);
    await this.waitForTabIdle(view, target);
    if (manager.activeTabId !== target.id && typeof manager.switchToTab === 'function') {
      await manager.switchToTab(target.id);
      await sleep(300);
    }
    const active = typeof manager.getActiveTab === 'function' ? manager.getActiveTab() : target;
    const beforeCount = this.getTabMessages(view, active).length;
    const controller = active && active.controllers && active.controllers.inputController;
    if (!controller || typeof controller.sendMessage !== 'function') throw new Error('Claudian input controller is unavailable.');

    const send = controller.sendMessage({ content: prompt });
    await Promise.race([
      send,
      sleep(AGENT_TIMEOUT_MS).then(() => { throw new Error('AI task timed out after 30 minutes'); }),
    ]);
    await this.waitForTabIdle(view, active);
    await sleep(300);
    return this.lastAssistantReply(view, active, beforeCount);
  }

  async tick() {
    if (this.running) return;
    const now = Date.now();
    const due = this.jobs.filter(job => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now)
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));
    if (!due.length) return;
    this.running = true;
    try {
      for (const job of due) await this.executeJob(job);
    } finally {
      this.running = false;
    }
  }

  async executeJob(job) {
    job.status = 'running';
    job.lastRunAt = new Date().toISOString();
    job.attempts = Number(job.attempts || 0) + 1;
    await this.saveState();
    try {
      const executionPrompt = `${job.prompt}\n\nIf this work reveals a concrete future action, you may append at most three follow-up jobs using <assistant-scheduler>[{"title":"...","prompt":"...","schedule":{"kind":"once","at":"ISO-8601"}}]</assistant-scheduler>. Do not create follow-ups unless they are genuinely useful.`;
      const reply = job.routine === 'daily-review'
        ? await this.runDailyReview(false)
        : await this.sendToClaudian(executionPrompt, job.tab || this.settings.assistantTab);
      job.lastReply = reply || '';
      job.lastStatus = 'completed';
      job.lastError = null;
      job.status = 'completed';
      await this.processFollowUps(reply, job.tab || this.settings.assistantTab);
      if (job.output && job.output.folder && reply) {
        await this.writeOutput(job.output.folder, job.output.filename, reply);
      }
      if (job.schedule.kind === 'once') {
        job.enabled = false;
        job.nextRunAt = null;
      } else if (job.schedule.kind === 'event') {
        job.nextRunAt = null;
      } else {
        job.nextRunAt = getScheduleNextRun(job.schedule, new Date());
      }
      this.logActivity('completed', job.title, job.id);
      if (this.settings.notifyOnCompletion && job.notify !== false) new Notice(`AI completed: ${job.title}`, 5000);
    } catch (error) {
      job.status = 'failed';
      job.lastStatus = 'failed';
      job.lastError = errorText(error);
      if (job.schedule.kind === 'once') {
        job.enabled = false;
        job.nextRunAt = null;
      } else if (job.schedule.kind === 'event') {
        job.nextRunAt = null;
      } else {
        job.nextRunAt = getScheduleNextRun(job.schedule, new Date());
      }
      this.lastTickError = job.lastError;
      this.logActivity('failed', `${job.title}: ${job.lastError}`, job.id);
      new Notice(`AI task failed: ${job.title}\n${job.lastError}`, 8000);
    }
    await this.saveState();
  }

  async handleVaultChange(file) {
    if (!file || !file.path || this.running) return;
    const eventJobs = this.jobs.filter(job => job.enabled && job.schedule && job.schedule.kind === 'event'
      && (!job.schedule.event || job.schedule.event === 'modify' || job.schedule.event === 'vault-change'));
    if (!eventJobs.length) return;
    const now = Date.now();
    for (const job of eventJobs) {
      const cooldown = Number(job.cooldownMinutes || 10) * 60000;
      if (job.lastRunAt && now - new Date(job.lastRunAt).getTime() < cooldown) continue;
      job.nextRunAt = new Date(now + 2000).toISOString();
      job.lastEventPath = file.path;
    }
    await this.saveState();
  }

  async addJob(raw) {
    const job = normalizeJob(raw);
    this.jobs.push(job);
    await this.saveState();
    return job;
  }

  async ensureNightlyReviewJob() {
    let job = this.jobs.find(candidate => candidate.routine === 'daily-review');
    if (!this.settings.nightlyReviewEnabled) {
      if (job) { job.enabled = false; job.nextRunAt = null; }
      return;
    }
    if (!job) {
      job = normalizeJob({
        id: 'nightly-daily-review',
        title: 'Nightly daily review',
        prompt: '',
        tab: this.settings.assistantTab,
        routine: 'daily-review',
        schedule: { kind: 'daily', time: this.settings.reviewTime },
        notify: true,
      });
      this.jobs.push(job);
    } else {
      job.enabled = true;
      job.tab = this.settings.assistantTab;
      job.schedule = { kind: 'daily', time: this.settings.reviewTime };
      if (!job.nextRunAt || new Date(job.nextRunAt) <= new Date()) job.nextRunAt = nextDailyRun(this.settings.reviewTime);
    }
  }

  async runDailyReview(manual) {
    const today = localDateKey();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const files = this.app.vault.getMarkdownFiles()
      .filter(file => file.stat && file.stat.mtime >= start.getTime() && !file.path.startsWith(`${this.settings.reportFolder}/`))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const fileList = files.length ? files.map(file => `- ${file.path}`).join('\n') : '- No Markdown files were created or modified today.';
    const prompt = [
      'You are the user\'s autonomous evening review assistant inside Obsidian.',
      `Today is ${today}. Review the user\'s work from today and produce a useful daily report.`,
      'Use Claudian vault tools to read the listed Markdown files before analyzing them.',
      'Do not invent activity. Distinguish facts from suggestions.',
      'Return Markdown only, with these headings: ## Summary, ## Work Completed, ## Important Ideas, ## Open Loops, ## Suggested Next Steps.',
      `Files modified today:\n${fileList}`,
    ].join('\n\n');
    const reply = await this.sendToClaudian(prompt, this.settings.assistantTab);
    const report = reply || `# Daily Review - ${today}\n\nThe assistant did not return a report.`;
    const path = `${this.settings.reportFolder}/${today}.md`;
    await this.writeOutput(this.settings.reportFolder, `${today}.md`, `# Daily Review - ${today}\n\n${report}`);
    this.logActivity('review', `Daily review written to ${path}`);
    if (manual || this.settings.notifyOnCompletion) new Notice(`Daily review written to ${path}`, 6000);
    await this.saveState();
    return report;
  }

  async writeOutput(folder, filename, content) {
    const cleanFolder = normalizePath(String(folder || '').replace(/^\/+|\/+$/g, ''));
    const cleanName = String(filename || `${localDateKey()}.md`).replace(/[\\/]/g, '-');
    const path = normalizePath(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
    await this.ensureFolder(cleanFolder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && typeof this.app.vault.modify === 'function') await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
    return path;
  }

  async ensureFolder(folder) {
    if (!folder) return;
    const parts = folder.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch (_) { /* another operation may have created it */ }
      }
    }
  }

  async processFollowUps(reply, tab) {
    const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
    for (const plan of plans.slice(0, 5)) {
      await this.addJob(this.jobFromPlan(plan, tab, 'self-talk'));
    }
  }

  jobFromPlan(plan, fallbackTab, source) {
    const schedule = plan.schedule || {};
    const normalized = {
      kind: schedule.kind || 'once',
      at: schedule.at,
      time: schedule.time,
      days: schedule.days,
      event: schedule.event,
    };
    return {
      title: String(plan.title).slice(0, 120),
      prompt: String(plan.prompt),
      tab: Number(plan.tab || fallbackTab || this.settings.assistantTab),
      schedule: normalized,
      nextRunAt: normalized.kind === 'event' ? null : getScheduleNextRun(normalized),
      output: plan.output || null,
      notify: plan.notify !== false,
      cooldownMinutes: plan.cooldownMinutes || schedule.cooldownMinutes,
      source,
    };
  }

  async planAndCreate(goal, tab = this.settings.assistantTab) {
    const prompt = [
      'You are the planning brain for an autonomous Obsidian AI assistant.',
      'Turn the user goal below into one or more safe, concrete automation jobs.',
      'Return ONLY a JSON array inside <assistant-scheduler> tags. No Markdown outside the tags.',
      'Each item must have: title, prompt, schedule.',
      'schedule must be one of:',
      '- {"kind":"once","at":"ISO-8601 timestamp"}',
      '- {"kind":"daily","time":"HH:MM"}',
      '- {"kind":"weekly","time":"HH:MM","days":[0,1,2,3,4,5,6]}',
      '- {"kind":"event","event":"modify","cooldownMinutes":10}',
      'Use the user\'s local time. Add output {"folder":"...","filename":"..."} only when a note should be saved.',
      'A prompt should tell the future agent exactly what to do and what vault context to inspect.',
      `User goal:\n${goal}`,
    ].join('\n');
    const reply = await this.sendToClaudian(prompt, tab);
    const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
    if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
    const jobs = [];
    for (const plan of plans.slice(0, 10)) jobs.push(await this.addJob(this.jobFromPlan(plan, tab, 'planner')));
    this.logActivity('planned', `AI created ${jobs.length} job(s)`);
    await this.saveState();
    return { reply, jobs };
  }

  async retryJob(job) {
    job.enabled = true;
    job.status = 'scheduled';
    job.lastError = null;
    job.nextRunAt = job.schedule.kind === 'event' ? new Date().toISOString() : getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
    await this.saveState();
    await this.tick();
  }
};

class AssistantModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  async onOpen() {
    this.render();
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'AI Assistant' });
    contentEl.createEl('p', { text: 'This plugin wakes Claudian at scheduled times, starts self-talk, and writes results into your vault.' });
    contentEl.createEl('p', { text: 'Obsidian must be running for jobs to execute. Missed jobs can be caught up after you reopen it.' });

    const actions = new Setting(contentEl);
    actions.addButton(button => button.setButtonText('Ask AI to plan').setCta().onClick(() => new PlannerModal(this.app, this.plugin).open()));
    actions.addButton(button => button.setButtonText('Run daily review').onClick(async () => {
      try { await this.plugin.runDailyReview(true); } catch (error) { new Notice(`Review failed: ${errorText(error)}`, 8000); }
    }));
    actions.addButton(button => button.setButtonText(this.plugin.settings.nightlyReviewEnabled ? 'Disable nightly review' : 'Enable nightly review').onClick(async () => {
      this.plugin.settings.nightlyReviewEnabled = !this.plugin.settings.nightlyReviewEnabled;
      await this.plugin.ensureNightlyReviewJob();
      await this.plugin.saveState();
      this.render();
    }));

    const scheduled = this.plugin.jobs.filter(job => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    contentEl.createEl('h3', { text: `Active jobs (${scheduled.length})` });
    if (!scheduled.length) contentEl.createEl('p', { text: 'No active jobs. Ask the AI to create one from a natural-language goal.' });
    for (const job of scheduled) {
      new Setting(contentEl)
        .setName(job.title)
        .setDesc(`${describeSchedule(job)}${job.status === 'failed' ? ` - ${job.lastError}` : ''}`)
        .addButton(button => button.setButtonText('Disable').onClick(async () => {
          job.enabled = false; job.nextRunAt = null; await this.plugin.saveState(); this.render();
        }));
    }

    const recent = this.plugin.jobs.filter(job => !job.enabled || job.lastStatus).slice(-5).reverse();
    contentEl.createEl('h3', { text: 'Recent activity' });
    for (const job of recent) {
      const mark = job.lastStatus === 'completed' ? '[ok]' : job.lastStatus === 'failed' ? '[failed]' : '[off]';
      const row = contentEl.createEl('div', { text: `${mark} ${job.title} - ${job.lastRunAt ? formatDate(job.lastRunAt) : 'not run'}`, cls: 'setting-item-description' });
      if (job.lastStatus === 'failed') {
        const retry = row.createEl('button', { text: 'Retry' });
        retry.onclick = async () => { await this.plugin.retryJob(job); this.render(); };
      }
    }
  }

  onClose() { this.contentEl.empty(); }
}

class PlannerModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Ask the AI to plan' });
    contentEl.createEl('p', { text: 'Describe the outcome you want. The AI will turn it into scheduled, recurring, or vault-triggered jobs.' });
    const textarea = contentEl.createEl('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '130px';
    textarea.placeholder = 'Every evening, review the notes I changed today and create a report in AI Reviews. Also remind me every Monday to review open loops.';
    new Setting(contentEl)
      .addButton(button => button.setButtonText('Create AI plan').setCta().onClick(async () => {
        const goal = textarea.value.trim();
        if (!goal) { new Notice('Describe what you want the assistant to do.'); return; }
        button.setDisabled(true);
        try {
          const result = await this.plugin.planAndCreate(goal);
          new Notice(`AI created ${result.jobs.length} job(s)`, 6000);
          this.close();
          new AssistantModal(this.app, this.plugin).open();
        } catch (error) {
          new Notice(`Planning failed: ${errorText(error)}`, 8000);
          button.setDisabled(false);
        }
      }))
      .addButton(button => button.setButtonText('Close').onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'AI Scheduler' });
    containerEl.createEl('p', { text: 'This plugin schedules Claudian. It does not contain a model or provider of its own.' });
    new Setting(containerEl)
      .setName('Assistant chat number')
      .setDesc('The Claudian tab used for autonomous work.')
      .addText(text => text.setValue(String(this.plugin.settings.assistantTab)).onChange(async value => {
        const number = Math.max(1, Number.parseInt(value, 10) || 1);
        this.plugin.settings.assistantTab = number;
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Nightly review')
      .setDesc('Opt-in: analyze today\'s modified Markdown files and create a report.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange(async value => {
        this.plugin.settings.nightlyReviewEnabled = value;
        await this.plugin.ensureNightlyReviewJob();
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Nightly review time')
      .setDesc('Local 24-hour time, for example 22:00.')
      .addText(text => text.setValue(this.plugin.settings.reviewTime).onChange(async value => {
        this.plugin.settings.reviewTime = parseClock(value) && /^\d{1,2}:\d{2}$/.test(value) ? value : this.plugin.settings.reviewTime;
        await this.plugin.ensureNightlyReviewJob();
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Report folder')
      .setDesc('Vault folder for daily review notes.')
      .addText(text => text.setValue(this.plugin.settings.reportFolder).onChange(async value => {
        this.plugin.settings.reportFolder = value.trim() || DEFAULT_SETTINGS.reportFolder;
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Completion notifications')
      .setDesc('Show an Obsidian notice when an AI job finishes.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange(async value => {
        this.plugin.settings.notifyOnCompletion = value;
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Run missed jobs after startup')
      .setDesc('Catch up jobs that became due while Obsidian was closed.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange(async value => {
        this.plugin.settings.catchUpOnStart = value;
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Startup catch-up window (hours)')
      .setDesc('Do not run jobs missed longer ago than this window.')
      .addText(text => text.setValue(String(this.plugin.settings.catchUpHours)).onChange(async value => {
        this.plugin.settings.catchUpHours = Math.max(1, Number.parseInt(value, 10) || 24);
        await this.plugin.saveState();
      }));
  }
}
