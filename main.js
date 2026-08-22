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
  defaultProfile: '',
  planningProfile: '',
  nightlyProfile: '',
  reportFolder: 'AI Reviews',
  reviewTime: '22:00',
  nightlyReviewEnabled: false,
  notifyOnCompletion: true,
  catchUpOnStart: false,
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
    this.settings.defaultProfile = this.settings.defaultProfile || this.settings.planningProfile || '';
    this.settings.planningProfile = this.settings.planningProfile || this.settings.defaultProfile;
    this.settings.nightlyProfile = (data.settings && data.settings.nightlyProfile) || '';
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
    await this.saveData({ version: 4, settings: this.settings, jobs: this.jobs, activity: this.activity.slice(-50) });
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
        ? await this.runDailyReview(false, execution)
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
    const profile = this.settings.nightlyProfile || this.settings.defaultProfile || this.settings.planningProfile || '';
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
        profile,
        routine: 'daily-review',
        schedule: { kind: 'daily', time: this.settings.reviewTime },
        notify: true,
      });
      this.jobs.push(job);
    } else {
      job.enabled = true;
      job.tab = this.settings.assistantTab;
      if (job.profile !== profile) {
        job.profile = profile;
        job.conversationId = null;
        job.providerId = null;
        job.model = null;
      }
      job.schedule = { kind: 'daily', time: this.settings.reviewTime };
      if (!job.nextRunAt || new Date(job.nextRunAt) <= new Date()) job.nextRunAt = nextDailyRun(this.settings.reviewTime);
    }
  }

  async runDailyReview(manual, execution = null) {
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
    const nightlyJob = this.jobs.find(candidate => candidate.routine === 'daily-review');
    const resolved = execution || (nightlyJob
      ? await this.resolveJobExecution(nightlyJob)
      : await this.resolveExecutionProfile(this.settings.nightlyProfile || this.settings.defaultProfile || this.settings.planningProfile || ''));
    const reply = await this.sendToClaudian(prompt, resolved.tab, resolved.conversationId);
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

  getExecutionProfiles() {
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
          ? `Chat ${index + 1} - ${conversation.title || 'Untitled'} (${this.getProviderName(providerId)}${conversation.selectedModel ? ` / ${conversation.selectedModel}` : ''})`
          : `Chat ${index + 1} - use its current Claudian model`,
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

  getClaudianViewSync() {
    const claudian = this.getClaudianPlugin();
    return claudian && typeof claudian.getAllViews === 'function' ? claudian.getAllViews()[0] || null : null;
  }

  profileValue(providerId, model) {
    return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || '' }))}`;
  }

  parseProfileValue(value) {
    if (!String(value || '').startsWith('profile:')) return null;
    try { return JSON.parse(decodeURIComponent(String(value).slice(8))); } catch (_) { return null; }
  }

  async resolveExecutionProfile(value) {
    const selected = value === undefined || value === null ? this.settings.planningProfile : value;
    if (String(selected).startsWith('tab:')) {
      const tab = Math.max(1, Number.parseInt(String(selected).slice(4), 10) || 1);
      const view = await this.getClaudianView();
      const runtime = this.getTab(view, tab);
      const conversation = runtime && runtime.conversationId && this.getClaudianPlugin().getConversationSync
        ? this.getClaudianPlugin().getConversationSync(runtime.conversationId) : null;
      return { profile: selected, tab, conversationId: runtime && runtime.conversationId || null, providerId: conversation && conversation.providerId || null, model: conversation && conversation.selectedModel || null };
    }
    const profile = this.parseProfileValue(selected);
    if (profile && profile.providerId) {
      const claudian = this.getClaudianPlugin();
      if (!claudian || typeof claudian.createConversation !== 'function') throw new Error('Claudian cannot create a conversation for the selected provider.');
      const conversation = await claudian.createConversation({
        providerId: profile.providerId,
        ...(profile.model ? { selectedModel: profile.model } : {}),
      });
      if (conversation && conversation.id && typeof claudian.renameConversation === 'function') {
        await claudian.renameConversation(conversation.id, 'AI Scheduler - Planning');
      }
      return { profile: selected, tab: this.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
    }
    return { profile: '', tab: this.settings.assistantTab, conversationId: null, providerId: null, model: null };
  }

  async resolveJobExecution(job) {
    if (job.conversationId) {
      return {
        profile: job.profile || '',
        tab: job.tab || this.settings.assistantTab,
        conversationId: job.conversationId,
        providerId: job.providerId || null,
        model: job.model || null,
      };
    }
    const selected = job.profile || this.settings.defaultProfile || this.settings.planningProfile || '';
    const execution = await this.resolveExecutionProfile(selected);
    Object.assign(job, {
      profile: execution.profile,
      tab: execution.tab,
      conversationId: execution.conversationId,
      providerId: execution.providerId,
      model: execution.model,
    });
    return execution;
  }

  async assignJobProfile(job, profileValue) {
    const execution = await this.resolveExecutionProfile(profileValue);
    Object.assign(job, {
      profile: execution.profile,
      tab: execution.tab,
      conversationId: execution.conversationId,
      providerId: execution.providerId,
      model: execution.model,
    });
    await this.saveState();
    return execution;
  }

  async applyProfileToActiveJobs(profileValue) {
    const execution = await this.resolveExecutionProfile(profileValue);
    for (const job of this.jobs.filter(candidate => candidate.enabled)) {
      Object.assign(job, {
        profile: execution.profile,
        tab: execution.tab,
        conversationId: execution.conversationId,
        providerId: execution.providerId,
        model: execution.model,
      });
    }
    this.settings.defaultProfile = profileValue;
    this.settings.planningProfile = profileValue;
    this.settings.nightlyProfile = '';
    await this.ensureNightlyReviewJob();
    await this.saveState();
  }

  async planAndCreate(goal, selection = this.settings.planningProfile) {
    const execution = await this.resolveExecutionProfile(selection);
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
    const reply = await this.sendToClaudian(prompt, execution.tab, execution.conversationId);
    const plans = extractJson(reply).filter(item => item && item.title && item.prompt && item.schedule);
    if (!plans.length) throw new Error('The AI returned no valid schedule. Ask it for a concrete time or cadence.');
    const jobs = [];
    for (const plan of plans.slice(0, 10)) {
      jobs.push(await this.addJob(Object.assign(
        this.jobFromPlan(plan, execution.tab, 'planner'),
        { profile: execution.profile, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model },
      )));
    }
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
    const connected = Boolean(this.plugin.getTabManager(this.plugin.getClaudianViewSync()));

    const hero = styleElement(shell.createEl('div'), { display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', marginBottom: '26px' });
    const heroCopy = hero.createEl('div');
    styleElement(heroCopy.createEl('div', { text: 'CLAUDIAN / AUTONOMY' }), { color: 'var(--interactive-accent)', fontSize: '11px', fontWeight: '700', letterSpacing: '0.12em', marginBottom: '8px' });
    styleElement(heroCopy.createEl('h1', { text: 'AI Assistant' }), { fontSize: '32px', margin: '0 0 8px', letterSpacing: '-0.03em' });
    styleElement(heroCopy.createEl('p', { text: 'A quiet control layer for scheduled work, self-talk, and vault memory.' }), { margin: '0', color: 'var(--text-muted)', maxWidth: '510px', lineHeight: '1.5' });
    const status = styleElement(hero.createEl('span', { text: connected ? 'Connected' : 'Open Claudian' }), { flex: '0 0 auto', borderRadius: '999px', padding: '6px 10px', fontSize: '11px', fontWeight: '700', color: connected ? 'var(--text-success)' : 'var(--text-warning)', background: connected ? 'var(--background-modifier-success)' : 'var(--background-modifier-error)' });
    status.setAttribute('aria-label', connected ? 'Claudian is connected' : 'Open Claudian to connect');

    const actions = styleElement(shell.createEl('div'), { display: 'flex', gap: '10px', flexWrap: 'wrap', paddingBottom: '24px', borderBottom: '1px solid var(--background-modifier-border)' });
    makeButton(actions, 'Ask AI to plan', () => new PlannerModal(this.app, this.plugin).open(), true);
    makeButton(actions, 'Run daily review', async button => {
      button.disabled = true;
      try { await this.plugin.runDailyReview(true); } catch (error) { new Notice(`Review failed: ${errorText(error)}`, 8000); }
      button.disabled = false;
      this.render();
    });
    makeButton(actions, this.plugin.settings.nightlyReviewEnabled ? 'Disable nightly review' : 'Enable nightly review', async () => {
      this.plugin.settings.nightlyReviewEnabled = !this.plugin.settings.nightlyReviewEnabled;
      await this.plugin.ensureNightlyReviewJob();
      await this.plugin.saveState();
      this.render();
    });

    const profiles = this.plugin.getExecutionProfiles();
    if (profiles.length) {
      const globalCard = makeCard(shell.createEl('div'), { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', marginTop: '18px', padding: '12px 14px' });
      const globalCopy = globalCard.createEl('div');
      styleElement(globalCopy.createEl('div', { text: 'Default profile for all tasks' }), { fontWeight: '600', fontSize: '13px' });
      styleElement(globalCopy.createEl('div', { text: 'Choose once, or apply this profile to every active job.' }), { color: 'var(--text-muted)', fontSize: '11px', marginTop: '3px' });
      const globalControls = styleElement(globalCard.createEl('div'), { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' });
      const globalSelect = globalControls.createEl('select');
      styleElement(globalSelect, { maxWidth: '230px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary)', color: 'var(--text-normal)', fontSize: '11px' });
      profiles.forEach(profile => globalSelect.createEl('option', { value: profile.value, text: profile.label }));
      const preferredGlobal = this.plugin.settings.defaultProfile || this.plugin.settings.planningProfile;
      globalSelect.value = profiles.some(profile => profile.value === preferredGlobal) ? preferredGlobal : profiles[0].value;
      makeButton(globalControls, 'Apply to active jobs', async button => {
        button.disabled = true;
        try { await this.plugin.applyProfileToActiveJobs(globalSelect.value); this.render(); }
        catch (error) { new Notice(`Could not apply profile: ${errorText(error)}`, 8000); button.disabled = false; }
      });
      globalSelect.onchange = async () => {
        this.plugin.settings.defaultProfile = globalSelect.value;
        await this.plugin.ensureNightlyReviewJob();
        await this.plugin.saveState();
      };
    }

    const stats = styleElement(shell.createEl('div'), { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', margin: '22px 0' });
    const activeCount = this.plugin.jobs.filter(job => job.enabled).length;
    const profileCount = profiles.length;
    [[activeCount, 'ACTIVE JOBS'], [profileCount, 'AI PROFILES'], [connected ? 'READY' : 'WAITING', 'RUNTIME']].forEach(([value, label]) => {
      const stat = makeCard(stats, { padding: '13px 14px' });
      styleElement(stat.createEl('div', { text: String(value) }), { fontSize: '20px', fontWeight: '700' });
      styleElement(stat.createEl('div', { text: label }), { marginTop: '3px', fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)' });
    });

    this.renderSection(shell, 'Active jobs', `${activeCount} ${activeCount === 1 ? 'job' : 'jobs'} currently enabled`);
    const scheduled = this.plugin.jobs.filter(job => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    const jobs = shell.createEl('div');
    if (!scheduled.length) {
      const empty = makeCard(jobs, { color: 'var(--text-muted)' });
      empty.createEl('div', { text: 'Your assistant is waiting for a goal.' });
      styleElement(empty.createEl('div', { text: 'Ask it to review, remind, organize, or follow up on your work.' }), { marginTop: '6px', fontSize: '12px' });
    }
    for (const job of scheduled) {
      const card = makeCard(jobs, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
      const copy = card.createEl('div');
      styleElement(copy.createEl('div', { text: job.title }), { fontWeight: '600' });
      styleElement(copy.createEl('div', { text: describeSchedule(job) }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
      const profiles = this.plugin.getExecutionProfiles();
      if (profiles.length) {
        const profileSelect = copy.createEl('select');
        styleElement(profileSelect, { marginTop: '8px', maxWidth: '100%', padding: '5px 7px', borderRadius: '6px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary)', color: 'var(--text-muted)', fontSize: '11px' });
        const defaultProfile = this.plugin.settings.defaultProfile || this.plugin.settings.planningProfile;
        profileSelect.createEl('option', { value: '', text: defaultProfile ? 'Use global default profile' : 'Use fallback Claudian chat' });
        profiles.forEach(profile => profileSelect.createEl('option', { value: profile.value, text: profile.label }));
        profileSelect.value = job.profile || '';
        profileSelect.onchange = async () => {
          profileSelect.disabled = true;
          try {
            await this.plugin.assignJobProfile(job, profileSelect.value);
            this.render();
          } catch (error) {
            new Notice(`Could not change task model: ${errorText(error)}`, 8000);
            profileSelect.disabled = false;
          }
        };
      }
      makeButton(card, 'Disable', async () => { job.enabled = false; job.nextRunAt = null; await this.plugin.saveState(); this.render(); });
    }

    const activity = this.plugin.activity.slice(-5).reverse();
    this.renderSection(shell, 'Activity', activity.length ? 'The latest assistant events' : 'No activity yet');
    const activityCard = makeCard(shell.createEl('div'), { padding: '6px 16px' });
    if (!activity.length) styleElement(activityCard.createEl('div', { text: 'Activity will appear here after the assistant runs.', cls: 'setting-item-description' }), { padding: '10px 0' });
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
    styleElement(shell.createEl('h1', { text: 'Teach your assistant' }), { fontSize: '30px', margin: '0 0 8px', letterSpacing: '-0.03em' });
    styleElement(shell.createEl('p', { text: 'Describe the outcome. Claudian will turn it into safe, persistent jobs.' }), { margin: '0 0 22px', color: 'var(--text-muted)', lineHeight: '1.5' });

    const profileCard = makeCard(shell.createEl('div'), { marginBottom: '14px' });
    styleElement(profileCard.createEl('div', { text: 'Run planning with' }), { fontWeight: '600', marginBottom: '5px' });
    styleElement(profileCard.createEl('div', { text: 'Choose the exact provider and model configured in Claudian. The selected profile is also used for the generated jobs.' }), { color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.45', marginBottom: '10px' });
    const select = profileCard.createEl('select');
    styleElement(select, { width: '100%', padding: '9px 10px', borderRadius: '7px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary)', color: 'var(--text-normal)' });
    const profiles = this.plugin.getExecutionProfiles();
    if (!profiles.length) profiles.push({ value: 'tab:1', label: 'No Claudian profile found - open Claudian first' });
    profiles.forEach(profile => select.createEl('option', { value: profile.value, text: profile.label }));
    const preferred = this.plugin.settings.defaultProfile || this.plugin.settings.planningProfile;
    select.value = profiles.some(profile => profile.value === preferred) ? preferred : profiles[0].value;

    const textarea = shell.createEl('textarea');
    styleElement(textarea, { width: '100%', minHeight: '170px', resize: 'vertical', margin: '14px 0 8px', padding: '14px', borderRadius: '10px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary-alt)', color: 'var(--text-normal)', fontFamily: 'inherit', lineHeight: '1.5', boxSizing: 'border-box' });
    textarea.placeholder = 'Every evening, review the notes I changed today, identify open loops, and create a report in AI Reviews. Remind me every Monday to review unfinished work.';
    styleElement(shell.createEl('div', { text: 'Examples: review notes, prepare tomorrow, remind me about open loops, or react when a project file changes.' }), { color: 'var(--text-muted)', fontSize: '12px', marginBottom: '22px' });
    const footer = styleElement(shell.createEl('div'), { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
    makeButton(footer, 'Cancel', () => this.close());
    makeButton(footer, 'Create AI plan', async button => {
      const goal = textarea.value.trim();
      if (!goal) { new Notice('Describe what you want the assistant to do.'); return; }
      button.disabled = true;
      select.disabled = true;
      this.plugin.settings.planningProfile = select.value;
      await this.plugin.saveState();
      try {
        const result = await this.plugin.planAndCreate(goal, select.value);
        new Notice(`AI created ${result.jobs.length} job(s)`, 6000);
        this.close();
        new AssistantModal(this.app, this.plugin).open();
      } catch (error) {
        new Notice(`Planning failed: ${errorText(error)}`, 8000);
        button.disabled = false;
        select.disabled = false;
      }
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
    containerEl.createEl('p', { text: 'This plugin schedules Claudian. It does not contain a model or provider of its own.' });
    const profiles = this.plugin.getExecutionProfiles();
    if (profiles.length) {
      new Setting(containerEl)
        .setName('Default profile for all jobs')
        .setDesc('The provider/model used by tasks without their own profile, and preselected for planning.')
        .addDropdown(dropdown => {
          profiles.forEach(profile => dropdown.addOption(profile.value, profile.label));
          const value = this.plugin.settings.defaultProfile;
          dropdown.setValue(profiles.some(profile => profile.value === value) ? value : profiles[0].value);
          dropdown.onChange(async selected => {
            this.plugin.settings.defaultProfile = selected;
            await this.plugin.ensureNightlyReviewJob();
            await this.plugin.saveState();
          });
        });
    } else {
      containerEl.createEl('p', { text: 'Open Claudian once to expose its provider and model profiles here.' });
    }
    new Setting(containerEl)
      .setName('Assistant chat number')
      .setDesc('Fallback Claudian chat used when no provider profile is selected.')
      .addText(text => text.setValue(String(this.plugin.settings.assistantTab)).onChange(async value => {
        this.plugin.settings.assistantTab = Math.max(1, Number.parseInt(value, 10) || 1);
        await this.plugin.saveState();
      }));
    new Setting(containerEl)
      .setName('Nightly review')
      .setDesc('Opt-in: analyze today\'s modified Markdown files and create a report.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange(async value => {
        this.plugin.settings.nightlyReviewEnabled = value;
        await this.plugin.ensureNightlyReviewJob();
        await this.plugin.saveState();
        this.display();
      }));
    if (this.plugin.settings.nightlyReviewEnabled) {
      new Setting(containerEl)
        .setName('Nightly review time')
        .setDesc('Local 24-hour time, for example 22:00.')
        .addText(text => text.setValue(this.plugin.settings.reviewTime).onChange(async value => {
          if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) this.plugin.settings.reviewTime = value;
          await this.plugin.ensureNightlyReviewJob();
          await this.plugin.saveState();
        }));
      if (profiles.length) {
        new Setting(containerEl)
          .setName('Nightly review profile')
          .setDesc('Choose a model for the nightly review, or follow the global default.')
          .addDropdown(dropdown => {
            dropdown.addOption('', 'Use global default profile');
            profiles.forEach(profile => dropdown.addOption(profile.value, profile.label));
            dropdown.setValue(profiles.some(profile => profile.value === this.plugin.settings.nightlyProfile) ? this.plugin.settings.nightlyProfile : '');
            dropdown.onChange(async value => {
              this.plugin.settings.nightlyProfile = value;
              await this.plugin.ensureNightlyReviewJob();
              await this.plugin.saveState();
            });
          });
      }
      new Setting(containerEl)
        .setName('Report folder')
        .setDesc('Vault folder for daily review notes.')
        .addText(text => text.setValue(this.plugin.settings.reportFolder).onChange(async value => {
          this.plugin.settings.reportFolder = value.trim() || DEFAULT_SETTINGS.reportFolder;
          await this.plugin.saveState();
        }));
    }
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
