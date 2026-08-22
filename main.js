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
  planningModel: '',
  executionModel: '',
  dailyReviewModel: '',
  nightlyReviewModel: '',
  reportFolder: 'AI Reviews',
  reviewTime: '22:00',
  nightlyReviewEnabled: false,
  notifyOnCompletion: true,
  catchUpOnStart: false,
  catchUpHours: 24,
  reviewContextMode: 'modified-today',
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

function localTimestampKey(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${localDateKey(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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
    profile: null,
    conversationId: null,
    providerId: null,
    model: null,
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
    // Migrate the old profile names to explicit models for each action. The
    // values are still Claudian model references, but users no longer need to
    // understand the internal conversation/profile concept.
    const oldSettings = data.settings || {};
    const oldDefault = oldSettings.defaultProfile || oldSettings.planningProfile || '';
    this.settings.planningModel = this.settings.planningModel || oldSettings.planningProfile || oldDefault;
    this.settings.executionModel = this.settings.executionModel || oldDefault;
    this.settings.dailyReviewModel = this.settings.dailyReviewModel || oldSettings.nightlyProfile || oldDefault;
    this.settings.nightlyReviewModel = this.settings.nightlyReviewModel || oldSettings.nightlyProfile || oldDefault;
    // v2 shipped startup catch-up enabled. Apply the safer opt-in behavior to
    // existing installations as well as new ones.
    if (!data.version || data.version < 3) this.settings.catchUpOnStart = false;
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
    this.reviewRunning = false;
    this.lastTickError = null;

    this.addRibbonIcon('brain', 'Open AI Scheduler', () => new AssistantModal(this.app, this).open());
    this.addCommand({
      id: 'open-assistant',
      name: 'Open AI Scheduler',
      callback: () => new AssistantModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'plan-with-ai',
      name: 'Ask AI to plan a schedule',
      callback: () => new PlannerModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'run-daily-review',
      name: 'Run AI daily preview',
      callback: () => this.startReviewRun(true, 'daily'),
    });
    this.addCommand({
      id: 'run-nightly-review',
      name: 'Run AI nightly review now',
      callback: () => this.startReviewRun(true, 'nightly'),
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
    console.log('[ai-scheduler] scheduler loaded, jobs:', this.jobs.length);
  }

  async saveState() {
    await this.saveData({ version: 5, settings: this.settings, jobs: this.jobs, activity: this.activity.slice(-50) });
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
    const plugins = this.app.plugins && this.app.plugins.plugins;
    if (!plugins) return null;
    // Claudian's published Obsidian id is realclaudian. Keep the old id as a
    // fallback for development builds and older installations.
    return plugins.realclaudian || plugins.claudian || null;
  }

  async getClaudianView() {
    const claudian = this.getClaudianPlugin();
    if (!claudian) return null;
    let views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
    if (!views.length && typeof claudian.activateView === 'function') {
      try { await claudian.activateView(); } catch (_) { /* Claudian may already be opening */ }
      await sleep(1200);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
      if (views[0] && this.getTabManager(views[0])) return views[0];
      await sleep(500);
    }
    return views[0] || null;
  }

  getTabManager(view) {
    if (!view) return null;
    return typeof view.getTabManager === 'function' ? view.getTabManager() : view.tabManager || null;
  }

  getActiveTab(view, manager) {
    if (view && typeof view.getActiveTab === 'function') return view.getActiveTab();
    if (manager && typeof manager.getActiveTab === 'function') return manager.getActiveTab();
    return null;
  }

  getTab(view, number) {
    const manager = this.getTabManager(view);
    if (!manager) return null;
    const tabs = typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
    if (tabs.length) return tabs[Math.max(0, Number(number || 1) - 1)] || null;
    const items = typeof manager.getTabBarItems === 'function' ? manager.getTabBarItems() : [];
    const item = items[Math.max(0, Number(number || 1) - 1)];
    return item && typeof manager.getTab === 'function' ? manager.getTab(item.id) : null;
  }

  tabIsBusy(view, tab) {
    if (!tab) return false;
    const manager = this.getTabManager(view);
    const item = manager && typeof manager.getTabBarItems === 'function'
      ? manager.getTabBarItems().find(candidate => candidate.id === tab.id) : null;
    const working = manager && typeof manager.isTabWorking === 'function' ? manager.isTabWorking(tab.id) : false;
    return Boolean(working || tab.state && tab.state.isStreaming || tab.isStreaming || item && (item.isWorking || item.isStreaming));
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

  async sendToClaudian(prompt, tabNumber = this.settings.assistantTab, conversationId = null) {
    const view = await this.getClaudianView();
    const manager = this.getTabManager(view);
    if (!view || !manager) throw new Error('Claudian is installed but its chat view is not ready. Open the Claudian view once, then try again.');
    if (conversationId && typeof manager.openConversation === 'function') {
      await manager.openConversation(conversationId, { preferNewTab: false, activate: true });
      await sleep(300);
    }
    const target = conversationId ? this.getActiveTab(view, manager) : this.getTab(view, tabNumber);
    if (!target) throw new Error(`Claudian chat ${tabNumber} does not exist.`);
    await this.waitForTabIdle(view, target);
    const activeId = typeof manager.getActiveTabId === 'function' ? manager.getActiveTabId() : manager.activeTabId;
    if (activeId !== target.id && typeof manager.switchToTab === 'function') {
      await manager.switchToTab(target.id);
      await sleep(300);
    }
    const active = this.getActiveTab(view, manager) || target;
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
      const execution = await this.resolveJobExecution(job);
      await this.saveState();
      const executionPrompt = `${job.prompt}\n\nIf this work reveals a concrete future action, you may append at most three follow-up jobs using <assistant-scheduler>[{"title":"...","prompt":"...","schedule":{"kind":"once","at":"ISO-8601"}}]</assistant-scheduler>. Do not create follow-ups unless they are genuinely useful.`;
      const reply = job.routine === 'daily-review'
        ? await this.runDailyReview(false, execution, 'nightly')
        : await this.sendToClaudian(executionPrompt, execution.tab, execution.conversationId);
      job.lastReply = reply || '';
      job.lastStatus = 'completed';
      job.lastError = null;
      job.status = 'completed';
      await this.processFollowUps(reply, job);
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

  async startReviewRun(manual = true, kind = 'daily') {
    if (this.reviewRunning) {
      new Notice('A review is already running. You can keep using Obsidian while it finishes.', 5000);
      return;
    }
    this.reviewRunning = true;
    new Notice(`${kind === 'nightly' ? 'Nightly' : 'Daily'} review started. It will create ${this.settings.reportFolder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7000);
    void this.runDailyReview(manual, null, kind).catch(error => {
      this.logActivity('failed', `Review failed: ${errorText(error)}`);
      new Notice(`Review failed: ${errorText(error)}`, 8000);
      void this.saveState();
    }).finally(() => { this.reviewRunning = false; });
  }

  async runDailyReview(manual, execution = null, kind = 'daily') {
    const now = new Date();
    const today = localDateKey(now);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const files = this.app.vault.getMarkdownFiles()
      .filter(file => this.includeReviewFile(file, start))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const fileList = files.length ? files.map(file => `- ${file.path}`).join('\n') : '- No Markdown files were created or modified today.';
    const prompt = [
      `You are the user's ${kind === 'nightly' ? 'nightly review' : 'daily preview'} scheduler inside Obsidian.`,
      `Today is ${today}. Review the user's work from today and produce a useful report.`,
      'Use Claudian vault tools to read the listed Markdown files before analyzing them. Respect the user\'s existing Claudian permissions and do not access unrelated files.',
      'Do not invent activity. Distinguish facts from suggestions.',
      'Return Markdown only, with these headings: ## Summary, ## Work Completed, ## Important Ideas, ## Open Loops, ## Suggested Next Steps.',
      `Files modified today:\n${fileList}`,
    ].join('\n\n');
    const nightlyJob = this.jobs.find(candidate => candidate.routine === 'daily-review');
    const model = kind === 'nightly' ? this.settings.nightlyReviewModel : this.settings.dailyReviewModel;
    const resolved = execution || (nightlyJob && kind === 'nightly'
      ? await this.resolveJobExecution(nightlyJob)
      : await this.resolveModel(model, kind === 'nightly' ? 'nightly review' : 'daily preview'));
    const reply = await this.sendToClaudian(prompt, resolved.tab, resolved.conversationId);
    const reportTitle = kind === 'nightly' ? 'Nightly Review' : 'Daily Preview';
    const report = reply || `# ${reportTitle} - ${today}\n\nClaudian did not return a report.`;
    const timestamp = localTimestampKey(now);
    let filename = `${timestamp}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${this.settings.reportFolder}/${filename}`))) {
      filename = `${timestamp}-${suffix}.md`;
      suffix += 1;
    }
    const path = `${this.settings.reportFolder}/${filename}`;
    await this.writeOutput(this.settings.reportFolder, filename, `# ${reportTitle} - ${today}\n\nGenerated: ${formatDate(now.toISOString())}\n\n${report}`);
    this.logActivity('review', `Daily review written to ${path}`);
    if (manual || this.settings.notifyOnCompletion) new Notice(`Review written to ${path}`, 6000);
    await this.saveState();
    return report;
  }

  includeReviewFile(file, start) {
    if (!file || !file.path || file.path.startsWith(`${this.settings.reportFolder}/`)) return false;
    if (this.settings.reviewContextMode === 'all-markdown') return true;
    if (this.settings.reviewContextMode === 'no-files') return false;
    return Boolean(file.stat && file.stat.mtime >= start.getTime());
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

  async processFollowUps(reply, parentJob) {
    const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
    for (const plan of plans.slice(0, 5)) {
      await this.addJob(Object.assign(
        this.jobFromPlan(plan, parentJob.tab, 'self-talk'),
        {
          profile: parentJob.profile || null,
          conversationId: parentJob.conversationId || null,
          providerId: parentJob.providerId || null,
          model: parentJob.model || null,
        },
      ));
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
      profile: plan.profile || null,
      conversationId: plan.conversationId || null,
      providerId: plan.providerId || null,
      model: plan.model || null,
      schedule: normalized,
      nextRunAt: normalized.kind === 'event' ? null : getScheduleNextRun(normalized),
      output: plan.output || null,
      notify: plan.notify !== false,
      cooldownMinutes: plan.cooldownMinutes || schedule.cooldownMinutes,
      source,
    };
  }

  getProviderName(providerId) {
    const names = {
      claude: 'Claude',
      codex: 'Codex',
      grok: 'Grok',
      opencode: 'OpenCode',
      pi: 'Pi',
      acp: 'ACP',
    };
    return names[providerId] || providerId || 'Claudian';
  }

  getModelOptions() {
    const profiles = [];
    const seen = new Set();
    const add = (profile) => {
      if (!profile || !profile.providerId) return;
      const key = `${profile.providerId}\n${profile.model || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      profiles.push(profile);
    };
    const view = this.getClaudianViewSync();
    const manager = this.getTabManager(view);
    const tabs = manager && typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
    tabs.forEach((tab, index) => {
      const conversation = tab.conversationId && this.getClaudianPlugin().getConversationSync
        ? this.getClaudianPlugin().getConversationSync(tab.conversationId) : null;
      const providerId = conversation && conversation.providerId;
      profiles.push({
        value: `tab:${index + 1}`,
        label: providerId
          ? `Chat ${index + 1} - ${this.getProviderName(providerId)}${conversation.selectedModel ? ` / ${conversation.selectedModel}` : ' / current model'}`
          : `Chat ${index + 1} - current Claudian model`,
        tab: index + 1,
        conversationId: tab.conversationId,
        providerId: providerId || null,
        model: conversation && conversation.selectedModel || '',
      });
      if (providerId && tab.ui && tab.ui.modelSelector && typeof tab.ui.modelSelector.getAvailableModels === 'function') {
        try {
          tab.ui.modelSelector.getAvailableModels().forEach(option => add({
            value: this.profileValue(providerId, option.value),
            label: `${this.getProviderName(providerId)} / ${option.label || option.value}`,
            providerId,
            model: option.value,
          }));
        } catch (_) { /* Claudian may be rendering the selector */ }
      }
    });
    const claudian = this.getClaudianPlugin();
    const settings = claudian && (claudian.settings || claudian.providerHost && claudian.providerHost.settings) || {};
    const savedModels = settings.savedProviderModel || {};
    const last = settings.lastSelectedChatModel;
    if (last && last.providerId) add({
      value: this.profileValue(last.providerId, last.model),
      label: `${this.getProviderName(last.providerId)} / ${last.model || 'default model'}`,
      providerId: last.providerId,
      model: last.model || '',
    });
    Object.entries(savedModels).forEach(([providerId, model]) => add({
      value: this.profileValue(providerId, model),
      label: `${this.getProviderName(providerId)} / ${model || 'default model'}`,
      providerId,
      model: String(model || ''),
    }));
    const settingsProvider = settings.settingsProvider;
    const settingsModel = settingsProvider && (savedModels[settingsProvider] || settings.model);
    if (settingsProvider) add({
      value: this.profileValue(settingsProvider, settingsModel),
      label: `${this.getProviderName(settingsProvider)} / ${settingsModel || 'current model'}`,
      providerId: settingsProvider,
      model: String(settingsModel || ''),
    });
    return profiles;
  }

  getExecutionProfiles() { return this.getModelOptions(); }

  async refreshModels() {
    const view = await this.getClaudianView();
    if (!view || !this.getTabManager(view)) {
      throw new Error('Claudian is not ready. Open Claudian once, then refresh the model list.');
    }
    return this.getModelOptions();
  }

  getClaudianViewSync() {
    const claudian = this.getClaudianPlugin();
    return claudian && typeof claudian.getAllViews === 'function' ? claudian.getAllViews()[0] || null : null;
  }

  modelValue(providerId, model) {
    return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || '' }))}`;
  }

  profileValue(providerId, model) { return this.modelValue(providerId, model); }

  parseProfileValue(value) {
    if (!String(value || '').startsWith('profile:')) return null;
    try { return JSON.parse(decodeURIComponent(String(value).slice(8))); } catch (_) { return null; }
  }

  async resolveModel(value, action = 'this action') {
    const selected = value === undefined || value === null ? this.settings.executionModel : value;
    if (!selected) {
      throw new Error(`No model selected for ${action}. Choose a model in AI Scheduler settings first.`);
    }
    if (!this.getClaudianPlugin()) {
      throw new Error(`Claudian is not installed or enabled. It is required for ${action}.`);
    }
    const availableModels = this.getModelOptions();
    if (!availableModels.some(model => model.value === selected)) {
      throw new Error(`The selected model for ${action} is no longer available in Claudian. Refresh the model list and choose another model.`);
    }
    if (String(selected).startsWith('tab:')) {
      const tab = Math.max(1, Number.parseInt(String(selected).slice(4), 10) || 1);
      const view = await this.getClaudianView();
      const runtime = this.getTab(view, tab);
      if (!runtime) throw new Error(`The Claudian chat selected for ${action} no longer exists. Refresh the model list and choose another model.`);
      const claudian = this.getClaudianPlugin();
      const conversation = runtime && runtime.conversationId && claudian && claudian.getConversationSync
        ? claudian.getConversationSync(runtime.conversationId) : null;
      if (!conversation || !conversation.providerId) throw new Error(`The Claudian chat selected for ${action} has no configured provider.`);
       return { modelRef: selected, tab, conversationId: runtime && runtime.conversationId || null, providerId: conversation && conversation.providerId || null, model: conversation && conversation.selectedModel || null };
    }
    const profile = this.parseProfileValue(selected);
    if (profile && profile.providerId) {
      const claudian = this.getClaudianPlugin();
      if (!claudian) throw new Error(`Claudian is not installed or enabled. It is required for ${action}.`);
      if (typeof claudian.createConversation !== 'function') throw new Error(`Claudian cannot create a conversation for ${action}.`);
      let conversation;
      try {
        conversation = await claudian.createConversation({
          providerId: profile.providerId,
          ...(profile.model ? { selectedModel: profile.model } : {}),
        });
      } catch (error) {
        throw new Error(`Claudian could not create the selected model for ${action}: ${errorText(error)}`);
      }
      if (!conversation || !conversation.id) throw new Error(`Claudian returned no conversation for ${action}.`);
      if (conversation && conversation.id && typeof claudian.renameConversation === 'function') {
        await claudian.renameConversation(conversation.id, 'AI Scheduler - Planning');
      }
       return { modelRef: selected, tab: this.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
    }
    return { modelRef: '', tab: this.settings.assistantTab, conversationId: null, providerId: null, model: null };
  }

  async resolveExecutionProfile(value) { return this.resolveModel(value); }

  async resolveJobExecution(job) {
    const selectedModel = job.routine === 'daily-review' ? this.settings.nightlyReviewModel : this.settings.executionModel;
    const action = job.routine === 'daily-review' ? 'nightly review' : 'scheduled task execution';
    const execution = await this.resolveModel(selectedModel, action);
    Object.assign(job, {
      profile: execution.modelRef || null,
      tab: execution.tab,
      conversationId: execution.conversationId,
      providerId: execution.providerId,
      model: execution.model,
    });
    return execution;
  }

  async deleteJob(job) {
    this.jobs = this.jobs.filter(candidate => candidate.id !== job.id);
    this.logActivity('deleted', `Deleted ${job.title}`, job.id);
    await this.saveState();
  }

  async updateJob(job, changes) {
    Object.assign(job, changes);
    job.schedule = Object.assign({}, job.schedule, changes.schedule || {});
    job.nextRunAt = job.schedule.kind === 'event' ? null : getScheduleNextRun(job.schedule, new Date(Date.now() - 1000));
    job.enabled = true;
    job.status = 'scheduled';
    job.lastError = null;
    await this.saveState();
  }

  async refineJob(job, request) {
    const execution = await this.resolveModel(this.settings.planningModel, 'AI task editing');
    const prompt = [
      'You are editing an existing AI Scheduler job in Obsidian.',
      'Return ONLY one JSON object inside <assistant-scheduler> tags with title, prompt, and schedule.',
      'Preserve the existing schedule unless the user explicitly asks to change it.',
      `Existing job: ${JSON.stringify({ title: job.title, prompt: job.prompt, schedule: job.schedule })}`,
      `Requested change: ${request}`,
    ].join('\n\n');
    const reply = await this.sendToClaudian(prompt, execution.tab, execution.conversationId);
    const plan = extractJson(reply)[0];
    if (!plan || !plan.title || !plan.prompt || !plan.schedule) throw new Error('The AI returned an invalid job edit.');
    return plan;
  }

  async planAndCreate(goal) {
    const execution = await this.resolveModel(this.settings.planningModel, 'AI planning');
    const prompt = [
      'You are the planning brain for an autonomous Obsidian AI Scheduler.',
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
    const reply = await this.sendToClaudian(prompt, execution.tab, execution.conversationId);
    const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
    if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
    const jobs = [];
    for (const plan of plans.slice(0, 10)) {
      jobs.push(await this.addJob(Object.assign(
        this.jobFromPlan(plan, execution.tab, 'planner'),
        { profile: execution.modelRef, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model },
      )));
    }
    this.logActivity('planned', `AI created ${jobs.length} job(s)`);
    await this.saveState();
    return { reply, jobs };
  }

  async checkClaudianSetup() {
    const claudian = this.getClaudianPlugin();
    if (!claudian) return { ok: false, message: 'Claudian is not installed or enabled.' };
    const view = await this.getClaudianView();
    const manager = this.getTabManager(view);
    if (!view || !manager) return { ok: false, message: 'Claudian is installed, but its chat runtime is not ready. Open Claudian once and try again.' };
    const models = this.getModelOptions();
    if (!models.some(model => model.providerId)) return { ok: false, message: 'Claudian is open, but no provider/model is configured.' };
    return { ok: true, message: `Claudian is ready with ${models.length} available model option${models.length === 1 ? '' : 's'}.` };
  }

  testNotification() {
    new Notice('AI Scheduler notifications are working.');
    this.logActivity('notification', 'Test notification sent');
    void this.saveState();
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

function styleElement(element, styles) {
  Object.assign(element.style, styles);
  return element;
}

function makeButton(parent, label, onClick, primary = false) {
  const button = parent.createEl('button', { text: label });
  if (primary) button.addClass('mod-cta');
  button.onclick = () => { void onClick(button); };
  return button;
}

function makeCard(parent, styles = {}) {
  return styleElement(parent.createEl('div'), Object.assign({
    border: '1px solid var(--background-modifier-border)',
    borderRadius: '12px',
    padding: '16px',
    background: 'var(--background-primary-alt)',
  }, styles));
}

class AssistantModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onOpen() { this.render(); }

  render() {
    const { contentEl } = this;
    this.modalEl.style.width = 'min(760px, calc(100vw - 32px))';
    this.modalEl.style.maxHeight = 'min(760px, calc(100vh - 32px))';
    this.modalEl.style.padding = '0';
    contentEl.empty();
    styleElement(contentEl, { padding: '0', overflow: 'auto' });
    const shell = styleElement(contentEl.createEl('div'), { padding: '28px', maxWidth: '760px', margin: '0 auto' });
    styleElement(shell.createEl('h1', { text: 'AI Scheduler' }), { fontSize: '32px', margin: '0 0 8px', letterSpacing: '-0.03em' });
    styleElement(shell.createEl('p', { text: 'Plan work, run reviews, and manage scheduled tasks from one place.' }), { margin: '0 0 24px', color: 'var(--text-muted)', maxWidth: '560px', lineHeight: '1.5' });

    const actions = styleElement(shell.createEl('div'), { display: 'flex', gap: '10px', flexWrap: 'wrap', paddingBottom: '24px', borderBottom: '1px solid var(--background-modifier-border)' });
    makeButton(actions, 'Ask AI to plan', () => new PlannerModal(this.app, this.plugin).open(), true);
    makeButton(actions, 'Run daily preview', () => this.plugin.startReviewRun(true, 'daily'));
    makeButton(actions, this.plugin.settings.nightlyReviewEnabled ? 'Disable nightly review' : 'Enable nightly review', async () => {
      this.plugin.settings.nightlyReviewEnabled = !this.plugin.settings.nightlyReviewEnabled;
      await this.plugin.ensureNightlyReviewJob();
      await this.plugin.saveState();
      this.render();
    });
    makeButton(actions, 'Run review now', () => this.plugin.startReviewRun(true, 'nightly'));

    const activeCount = this.plugin.jobs.filter(job => job.enabled).length;
    const next = this.plugin.jobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
    const stats = styleElement(shell.createEl('div'), { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', margin: '22px 0' });
    [[activeCount, 'ACTIVE TASKS'], [next ? formatDate(next.nextRunAt) : 'None', 'NEXT RUN'], [this.plugin.settings.nightlyReviewEnabled ? 'ON' : 'OFF', 'NIGHTLY REVIEW']].forEach(([value, label]) => {
      const stat = makeCard(stats, { padding: '13px 14px' });
      styleElement(stat.createEl('div', { text: String(value) }), { fontSize: '17px', fontWeight: '700' });
      styleElement(stat.createEl('div', { text: label }), { marginTop: '3px', fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)' });
    });

    this.renderSection(shell, 'Scheduled tasks', `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} enabled`);
    const scheduled = this.plugin.jobs.filter(job => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    const jobs = shell.createEl('div');
    if (!scheduled.length) {
      const empty = makeCard(jobs, { color: 'var(--text-muted)' });
      empty.createEl('div', { text: 'No scheduled tasks yet.' });
      styleElement(empty.createEl('div', { text: 'Ask AI to plan a schedule from a plain-language goal.' }), { marginTop: '6px', fontSize: '12px' });
    }
    for (const job of scheduled) {
      const card = makeCard(jobs, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
      const copy = card.createEl('div');
      styleElement(copy.createEl('div', { text: job.title }), { fontWeight: '600' });
      styleElement(copy.createEl('div', { text: describeSchedule(job) }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
      const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
      makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
      makeButton(controls, 'Disable', async () => {
        if (job.routine === 'daily-review') {
          this.plugin.settings.nightlyReviewEnabled = false;
          await this.plugin.ensureNightlyReviewJob();
        } else {
          job.enabled = false;
          job.nextRunAt = null;
        }
        await this.plugin.saveState();
        this.render();
      });
      makeButton(controls, 'Delete', async () => { await this.plugin.deleteJob(job); this.render(); });
    }

    const past = this.plugin.jobs.filter(job => !job.enabled).slice(-6).reverse();
    if (past.length) {
      this.renderSection(shell, 'Past tasks', 'Completed, failed, or disabled');
      const pastList = shell.createEl('div');
      for (const job of past) {
        const card = makeCard(pastList, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
        const copy = card.createEl('div');
        styleElement(copy.createEl('div', { text: job.title }), { fontWeight: '600' });
        styleElement(copy.createEl('div', { text: job.lastStatus || job.status || 'disabled' }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
        const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
        makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
        makeButton(controls, 'Run again', async () => { await this.plugin.retryJob(job); this.render(); });
        makeButton(controls, 'Delete', async () => { await this.plugin.deleteJob(job); this.render(); });
      }
    }

    const activity = this.plugin.activity.slice(-8).reverse();
    this.renderSection(shell, 'Recent activity', activity.length ? 'All times are local' : 'No activity yet');
    const activityCard = makeCard(shell.createEl('div'), { padding: '6px 16px' });
    if (!activity.length) styleElement(activityCard.createEl('div', { text: 'Reviews, task runs, and notifications will appear here.' }), { padding: '10px 0', color: 'var(--text-muted)' });
    for (const event of activity) {
      const row = styleElement(activityCard.createEl('div'), { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--background-modifier-border)' });
      row.createEl('span', { text: event.message });
      styleElement(row.createEl('span', { text: formatDate(event.at) }), { color: 'var(--text-muted)', fontSize: '11px', whiteSpace: 'nowrap' });
    }
  }

  renderSection(parent, title, description) {
    const heading = styleElement(parent.createEl('div'), { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' });
    styleElement(heading.createEl('h2', { text: title }), { margin: '0', fontSize: '17px' });
    styleElement(heading.createEl('span', { text: description }), { color: 'var(--text-muted)', fontSize: '12px' });
  }

  onClose() { this.contentEl.empty(); }
}

class PlannerModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    this.modalEl.style.width = 'min(700px, calc(100vw - 32px))';
    this.modalEl.style.padding = '0';
    contentEl.empty();
    styleElement(contentEl, { padding: '0', overflow: 'auto' });
    const shell = styleElement(contentEl.createEl('div'), { padding: '28px', maxWidth: '700px', margin: '0 auto' });
    styleElement(shell.createEl('div', { text: 'AI PLANNER' }), { color: 'var(--interactive-accent)', fontSize: '11px', fontWeight: '700', letterSpacing: '0.12em', marginBottom: '8px' });
    styleElement(shell.createEl('h1', { text: 'Plan scheduled work' }), { fontSize: '30px', margin: '0 0 8px', letterSpacing: '-0.03em' });
    styleElement(shell.createEl('p', { text: 'Describe the outcome. Claudian will turn it into safe, persistent jobs.' }), { margin: '0 0 22px', color: 'var(--text-muted)', lineHeight: '1.5' });

    const textarea = shell.createEl('textarea');
    styleElement(textarea, { width: '100%', minHeight: '170px', resize: 'vertical', margin: '14px 0 8px', padding: '14px', borderRadius: '10px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary-alt)', color: 'var(--text-normal)', fontFamily: 'inherit', lineHeight: '1.5', boxSizing: 'border-box' });
    textarea.placeholder = 'Every evening, review the notes I changed today, identify open loops, and create a report in AI Reviews. Remind me every Monday to review unfinished work.';
    styleElement(shell.createEl('div', { text: 'Examples: review notes, prepare tomorrow, remind me about open loops, or react when a project file changes.' }), { color: 'var(--text-muted)', fontSize: '12px', marginBottom: '22px' });
    const footer = styleElement(shell.createEl('div'), { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
    makeButton(footer, 'Cancel', () => this.close());
    makeButton(footer, 'Create AI plan', async button => {
      const goal = textarea.value.trim();
      if (!goal) { new Notice('Describe what you want AI Scheduler to do.'); return; }
       button.disabled = true;
       try {
         const result = await this.plugin.planAndCreate(goal);
        new Notice(`AI created ${result.jobs.length} job(s)`, 6000);
        this.close();
        new AssistantModal(this.app, this.plugin).open();
      } catch (error) {
         new Notice(`Planning failed: ${errorText(error)}`, 8000);
         button.disabled = false;
       }
    }, true);
  }

  onClose() { this.contentEl.empty(); }
}

class JobModal extends Modal {
  constructor(app, plugin, job, onSaved) { super(app); this.plugin = plugin; this.job = job; this.onSaved = onSaved; }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.style.width = 'min(680px, calc(100vw - 32px))';
    contentEl.empty();
    const shell = styleElement(contentEl.createEl('div'), { padding: '24px' });
    shell.createEl('h2', { text: 'Edit scheduled task' });
    styleElement(shell.createEl('p', { text: 'Change the task directly or ask the planning model to rewrite it.' }), { color: 'var(--text-muted)', marginTop: '0' });
    const title = shell.createEl('input', { type: 'text', value: this.job.title, placeholder: 'Task title' });
    title.style.width = '100%';
    title.style.boxSizing = 'border-box';
    title.style.marginBottom = '10px';
    const prompt = shell.createEl('textarea', { text: this.job.prompt, placeholder: 'What should Claudian do?' });
    styleElement(prompt, { width: '100%', minHeight: '130px', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', padding: '10px', marginBottom: '10px' });
    const kind = shell.createEl('select');
    ['once', 'daily', 'weekly', 'event'].forEach(value => kind.createEl('option', { value, text: value[0].toUpperCase() + value.slice(1) }));
    kind.value = this.job.schedule.kind || 'once';
    kind.style.marginBottom = '10px';
    const schedule = shell.createEl('input', { type: 'text', value: this.job.schedule.kind === 'once' ? (this.job.schedule.at || '') : (this.job.schedule.time || ''), placeholder: 'ISO timestamp or HH:MM' });
    schedule.style.width = '100%';
    schedule.style.boxSizing = 'border-box';
    schedule.style.marginBottom = '10px';
    const request = shell.createEl('textarea', { placeholder: 'Optional: tell AI how to improve this task' });
    styleElement(request, { width: '100%', minHeight: '70px', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', padding: '10px', marginBottom: '12px' });
    const footer = styleElement(shell.createEl('div'), { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });
    makeButton(footer, 'Cancel', () => this.close());
    makeButton(footer, 'Improve with AI', async button => {
      if (!request.value.trim()) { new Notice('Describe what should change first.'); return; }
      button.disabled = true;
      try {
        const plan = await this.plugin.refineJob(this.job, request.value.trim());
        title.value = plan.title;
        prompt.value = plan.prompt;
        kind.value = plan.schedule.kind || 'once';
        schedule.value = plan.schedule.kind === 'once' ? (plan.schedule.at || '') : (plan.schedule.time || '');
        new Notice('AI suggested an updated task. Review it before saving.');
      } catch (error) { new Notice(`Could not improve task: ${errorText(error)}`, 8000); }
      button.disabled = false;
    });
    makeButton(footer, 'Save changes', async button => {
      if (!title.value.trim() || !prompt.value.trim()) { new Notice('A task needs a title and instructions.'); return; }
      const nextSchedule = { kind: kind.value };
      if (kind.value === 'once') nextSchedule.at = schedule.value.trim();
      else if (kind.value === 'event') nextSchedule.event = 'modify';
      else nextSchedule.time = schedule.value.trim();
      if (kind.value !== 'event' && !getScheduleNextRun(nextSchedule, new Date(Date.now() - 1000))) { new Notice('Enter a valid schedule value.'); return; }
      button.disabled = true;
      try {
        await this.plugin.updateJob(this.job, { title: title.value.trim(), prompt: prompt.value.trim(), schedule: nextSchedule });
        this.onSaved();
        this.close();
      } catch (error) { new Notice(`Could not save task: ${errorText(error)}`, 8000); button.disabled = false; }
    }, true);
  }

  onClose() { this.contentEl.empty(); }
}

class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'AI Scheduler' });
    containerEl.createEl('p', { text: 'Choose a Claudian model separately for each scheduler action. Model choices come from Claudian.' });
    const models = this.plugin.getModelOptions();
    new Setting(containerEl)
      .setName('Available Claudian models')
      .setDesc('Refresh this list after adding, removing, or changing models in Claudian.')
      .addButton(button => button.setButtonText('Refresh models').onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.refreshModels();
          new Notice('Claudian model list refreshed.');
          this.display();
        } catch (error) {
          new Notice(`Could not refresh models: ${errorText(error)}`, 8000);
          button.setDisabled(false);
        }
      }));
    const addModelSetting = (name, desc, key) => new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown(dropdown => {
        dropdown.addOption('', models.length ? 'Select a model' : 'No models found - open Claudian');
        models.forEach(model => dropdown.addOption(model.value, model.label));
        const selected = this.plugin.settings[key] || '';
        dropdown.setValue(models.some(model => model.value === selected) ? selected : '');
        dropdown.onChange(async value => { this.plugin.settings[key] = value; await this.plugin.saveState(); });
      });
    addModelSetting('Planning model', 'Used when Ask AI to plan creates tasks and when Improve with AI edits a task.', 'planningModel');
    addModelSetting('Scheduled task model', 'Used when an enabled task runs, including tasks created by the planner.', 'executionModel');
    addModelSetting('Daily preview model', 'Used by Run daily preview.', 'dailyReviewModel');
    addModelSetting('Nightly review model', 'Used by the recurring nightly review and Run review now.', 'nightlyReviewModel');

    new Setting(containerEl)
      .setName('Test notification')
      .setDesc('Send a normal Obsidian notification visible across the app, without using AI.')
      .addButton(button => button.setButtonText('Send test notification').onClick(() => this.plugin.testNotification()));
    new Setting(containerEl)
      .setName('Check Claudian setup')
      .setDesc('Verify that Claudian is installed, open, and has a configured model.')
      .addButton(button => button.setButtonText('Run check').onClick(async () => {
        button.setDisabled(true);
        const result = await this.plugin.checkClaudianSetup().catch(error => ({ ok: false, message: errorText(error) }));
        new Notice(result.message, result.ok ? 5000 : 8000);
        button.setDisabled(false);
      }));

    new Setting(containerEl)
      .setName('Review context')
      .setDesc('Files the daily and nightly reviews may inspect through Claudian vault tools.')
      .addDropdown(dropdown => dropdown
        .addOption('modified-today', 'Markdown files modified today')
        .addOption('all-markdown', 'All Markdown files')
        .addOption('no-files', 'No automatic files')
        .setValue(this.plugin.settings.reviewContextMode)
        .onChange(async value => { this.plugin.settings.reviewContextMode = value; await this.plugin.saveState(); }));

    new Setting(containerEl)
      .setName('Review report folder')
      .setDesc('Reports are saved as YYYY-MM-DD-HHmmss.md so every run is preserved.')
      .addText(text => text.setValue(this.plugin.settings.reportFolder).onChange(async value => {
        this.plugin.settings.reportFolder = value.trim() || DEFAULT_SETTINGS.reportFolder;
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Nightly review')
      .setDesc('Opt-in: create a timestamped review report on a recurring schedule.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange(async value => {
        this.plugin.settings.nightlyReviewEnabled = value;
        await this.plugin.ensureNightlyReviewJob();
        await this.plugin.saveState();
        this.display();
      }));
    new Setting(containerEl)
      .setName('Nightly review time')
      .setDesc('Local 24-hour time, for example 22:00.')
      .addText(text => text.setValue(this.plugin.settings.reviewTime).onChange(async value => {
        if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) this.plugin.settings.reviewTime = value;
        await this.plugin.ensureNightlyReviewJob();
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
      .setDesc('Off by default. Enable only if you explicitly want AI work to run after Obsidian was closed.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange(async value => {
        this.plugin.settings.catchUpOnStart = value;
        await this.plugin.saveState();
        this.display();
      }));
    if (this.plugin.settings.catchUpOnStart) {
      new Setting(containerEl)
        .setName('Startup catch-up window (hours)')
        .setDesc('Only jobs missed within this window will run after startup.')
        .addText(text => text.setValue(String(this.plugin.settings.catchUpHours)).onChange(async value => {
          this.plugin.settings.catchUpHours = Math.max(1, Number.parseInt(value, 10) || 24);
          await this.plugin.saveState();
        }));
    }
  }
}
