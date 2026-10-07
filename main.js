/*
AI Scheduler - an autonomy layer for Claudian and Obsidian Copilot.
This plugin deliberately does not call an AI provider directly. The selected
backend owns providers, models, permissions, and vault tools; this plugin owns
when the agent should wake up and what should happen after it replies.
*/

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  AISchedulerPlugin: () => AISchedulerPlugin,
  default: () => AISchedulerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian12 = require("obsidian");

// src/types.ts
var BACKEND_INFO = {
  claudian: {
    name: "Claudian",
    pluginId: "realclaudian",
    githubUrl: "https://github.com/YishenTu/claudian"
  },
  copilot: {
    name: "Obsidian Copilot",
    pluginId: "copilot",
    githubUrl: "https://github.com/logancyang/obsidian-copilot"
  }
};
var SCHEDULE_KINDS = ["once", "daily", "weekly", "monthly", "yearly", "hourly", "interval", "multi", "event", "cron"];

// src/cron/parse.ts
var CronParseError = class extends Error {
};
var FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];
var FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
var MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function fieldName(index) {
  return FIELD_NAMES[index];
}
function parseValue(text, index) {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const lower = trimmed.toLowerCase();
  const names = index === 3 ? MONTH_NAMES : index === 4 ? DOW_NAMES : null;
  if (names) {
    const offset = index === 3 ? 1 : 0;
    const exact = names.indexOf(lower);
    if (exact >= 0) return exact + offset;
    if (lower.length >= 3) {
      const matches = names.map((name, position) => name.startsWith(lower) ? position + offset : -1).filter((value) => value >= 0);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): "${trimmed}" is ambiguous.`);
    }
  }
  throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): "${trimmed}" is not a valid value.`);
}
function expandRange(min, max, step, lo, hi) {
  const values = [];
  if (min <= max) {
    for (let value = min; value <= max; value += step) values.push(value);
  } else {
    let value = min;
    let wrapped = false;
    while (true) {
      values.push(value);
      if (value === max) break;
      let next = value + step;
      if (!wrapped) {
        if (next > hi) {
          wrapped = true;
          next = lo + (next - hi - 1);
          if (next > max) break;
        }
      } else {
        if (next > max) break;
      }
      value = next;
    }
  }
  return values;
}
function parseField(field, index) {
  const [lo, hi] = FIELD_BOUNDS[index];
  const parts = field.split(",");
  if (parts.some((part) => part.trim() === "")) {
    throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): empty list element.`);
  }
  const collected = /* @__PURE__ */ new Set();
  let wildcard = false;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    let rangePart = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      rangePart = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): step "${stepText}" must be a positive integer.`);
      }
      step = Number(stepText);
    }
    let min;
    let max;
    if (rangePart === "*") {
      min = lo;
      max = hi;
      if (parts.length === 1 && slash < 0) wildcard = true;
    } else if (rangePart === "") {
      throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): missing value before step.`);
    } else {
      const dash = rangePart.indexOf("-");
      if (dash >= 0) {
        min = parseValue(rangePart.slice(0, dash), index);
        max = parseValue(rangePart.slice(dash + 1), index);
      } else {
        min = parseValue(rangePart, index);
        max = slash >= 0 ? hi : min;
      }
      if (min < lo || min > hi) {
        throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): ${min} is out of range ${lo}-${hi}.`);
      }
      if (max < lo || max > hi) {
        throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): ${max} is out of range ${lo}-${hi}.`);
      }
    }
    expandRange(min, max, step, lo, hi).forEach((value) => collected.add(value));
  }
  let values = [...collected];
  if (index === 4) values = values.map((value) => value === 7 ? 0 : value);
  values = [...new Set(values)].sort((a, b) => a - b);
  return { values, wildcard };
}
function parseCron(expression) {
  const source = String(expression || "").trim().replace(/\s+/g, " ");
  if (!source) throw new CronParseError("Cron expression is empty.");
  const fields = source.split(" ");
  if (fields.length !== 5) {
    throw new CronParseError(`A cron expression needs 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}.`);
  }
  const [minute, hour, dom, month, dow] = fields.map((field, index) => parseField(field, index));
  return {
    expression: source,
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domRestricted: !dom.wildcard,
    dowRestricted: !dow.wildcard
  };
}
function validateCron(expression) {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// src/cron/compute.ts
var MAX_SEARCH_YEARS = 8;
var MAX_ITERATIONS = 1e6;
function dayMatches(expression, date) {
  const domOk = expression.dom.includes(date.getDate());
  const dowOk = expression.dow.includes(date.getDay());
  if (expression.domRestricted && expression.dowRestricted) return domOk || dowOk;
  if (expression.domRestricted) return domOk;
  if (expression.dowRestricted) return dowOk;
  return true;
}
function nextDayStart(date) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}
function firstAllowedMinuteAtOrAfter(expression, date, after) {
  const minutes = expression.minute;
  const current = date.getMinutes();
  if (after) {
    const candidate2 = minutes.find((minute) => minute > current);
    if (candidate2 !== void 0) {
      const next = new Date(date.getTime());
      next.setMinutes(candidate2, 0, 0);
      return next;
    }
    return nextAllowedHourStart(expression, date);
  }
  const candidate = [...minutes].reverse().find((minute) => minute < current);
  if (candidate !== void 0) {
    const previous2 = new Date(date.getTime());
    previous2.setMinutes(candidate, 0, 0);
    return previous2;
  }
  const previous = new Date(date.getTime());
  previous.setHours(date.getHours() - 1, minutes[minutes.length - 1], 0, 0);
  return previous;
}
function nextAllowedHourStart(expression, date) {
  const current = date.getHours();
  const candidate = expression.hour.find((hour) => hour > current);
  if (candidate !== void 0) {
    const next = new Date(date.getTime());
    next.setHours(candidate, expression.minute[0], 0, 0);
    return next;
  }
  return nextDayStart(date);
}
function nextAllowedMonthStart(expression, date) {
  const current = date.getMonth() + 1;
  const year = date.getFullYear();
  const candidate = expression.month.find((month2) => month2 > current);
  const month = candidate !== void 0 ? candidate : expression.month[0];
  const monthYear = candidate !== void 0 ? year : year + 1;
  return new Date(monthYear, month - 1, 1, 0, 0, 0, 0);
}
function cronNext(expression, from = /* @__PURE__ */ new Date()) {
  const parsed = typeof expression === "string" ? parseCron(expression) : expression;
  let candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  if (candidate.getTime() <= from.getTime()) candidate = new Date(candidate.getTime() + 6e4);
  const limitYear = from.getFullYear() + MAX_SEARCH_YEARS;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (candidate.getFullYear() > limitYear) return null;
    if (!parsed.month.includes(candidate.getMonth() + 1)) {
      candidate = nextAllowedMonthStart(parsed, candidate);
      continue;
    }
    if (!dayMatches(parsed, candidate)) {
      candidate = nextDayStart(candidate);
      continue;
    }
    if (!parsed.hour.includes(candidate.getHours())) {
      candidate = nextAllowedHourStart(parsed, candidate);
      continue;
    }
    if (!parsed.minute.includes(candidate.getMinutes())) {
      candidate = firstAllowedMinuteAtOrAfter(parsed, candidate, true);
      continue;
    }
    return candidate;
  }
  return null;
}
function cronUpcoming(expression, count, from = /* @__PURE__ */ new Date()) {
  const runs = [];
  let cursor = from;
  for (let index = 0; index < count; index++) {
    const next = cronNext(expression, cursor);
    if (!next) break;
    runs.push(next);
    cursor = new Date(next.getTime() + 1);
  }
  return runs;
}

// src/cron/describe.ts
var MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var pad = (value) => String(value).padStart(2, "0");
function clockTime(minute, hour) {
  return `${pad(hour[0])}:${pad(minute[0])}`;
}
function isUniformStep(values, lo, hi) {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  if (step <= 1) return null;
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== lo + index * step) return null;
  }
  return values[values.length - 1] + step > hi ? step : null;
}
function rangesToList(values) {
  const runs = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] + 1 === value) last[1] = value;
    else runs.push([value, value]);
  }
  return runs;
}
function joinNatural(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
function nameList(values, names) {
  return joinNatural(rangesToList(values).map(([start, end]) => {
    if (start === end) return names[start];
    if (end - start >= 2) return `${names[start]} to ${names[end]}`;
    return `${names[start]} and ${names[end]}`;
  }));
}
function numberList(values, noun) {
  return joinNatural(rangesToList(values).map(([start, end]) => {
    if (start === end) return `${noun} ${start}`;
    return `${noun}s ${start} to ${end}`;
  }));
}
function timePhrase(expression) {
  const { minute, hour } = expression;
  if (minute.length === 60 && hour.length === 24) return "Every minute";
  const minuteStep = isUniformStep(minute, 0, 59);
  if (minuteStep && hour.length === 24) return `Every ${minuteStep} minutes`;
  const hourStep = isUniformStep(hour, 0, 23);
  if (hourStep && minute.length === 1) {
    return `Every ${hourStep === 1 ? "hour" : `${hourStep} hours`}${minute[0] === 0 ? "" : ` at :${pad(minute[0])}`}`;
  }
  if (minute.length === 1 && hour.length === 1) return `at ${clockTime(minute, hour)}`;
  if (hour.length === 1) return `at ${pad(hour[0])} past ${joinNatural(minute.map((value) => String(value)))}`;
  return `at minute ${joinNatural(minute.slice(0, 4).map((value) => String(value)))}${minute.length > 4 ? " and more" : ""} past hour ${joinNatural(hour.map((value) => String(value)))}`;
}
function dayPhrase(expression) {
  const domDays = expression.domRestricted ? expression.dom : null;
  const dowDays = expression.dowRestricted ? expression.dow : null;
  if (domDays && dowDays) {
    return `on ${numberList(domDays, "day")} or ${nameList(dowDays, DOW_SHORT)}`;
  }
  if (domDays) {
    if (domDays.length === 31) return "every day";
    return `on ${numberList(domDays, "day")} of the month`;
  }
  if (dowDays) {
    if (dowDays.length === 7) return "every day";
    return `on ${nameList(dowDays, DOW_LONG)}`;
  }
  return "every day";
}
function monthPhrase(expression) {
  if (expression.month.length === 12) return "";
  const names = rangesToList(expression.month).map(([start, end]) => {
    if (start === end) return MONTH_LONG[start - 1];
    return `${MONTH_LONG[start - 1]} to ${MONTH_LONG[end - 1]}`;
  });
  return ` in ${joinNatural(names)}`;
}
function describeCron(expression) {
  let parsed;
  try {
    parsed = parseCron(expression);
  } catch (e) {
    return "Invalid cron expression";
  }
  const dayPart = dayPhrase(parsed);
  const text = `${timePhrase(parsed)}${dayPart === "every day" ? "" : `, ${dayPart}`}${monthPhrase(parsed)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function formatLocalRun(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// src/util.ts
var sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
async function withTimeout(promise, ms, errorMessage) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== void 0) {
      window.clearTimeout(timer);
    }
  }
}
function validateJobSchema(item) {
  if (!item || typeof item !== "object") return null;
  const record = item;
  if (typeof record.title !== "string" || !record.title.trim()) return null;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) return null;
  if (!record.schedule || typeof record.schedule !== "object") return null;
  return record;
}
function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function errorText(error) {
  const message = error == null ? void 0 : error.message;
  return String(message || error);
}
function localDateKey(date = /* @__PURE__ */ new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function localTimestampKey(date = /* @__PURE__ */ new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${localDateKey(date)}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}
function formatDate(iso) {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function contentFromMessage(message) {
  if (!message) return "";
  const record = message;
  if (typeof record.content === "string") return record.content;
  if (typeof record.message === "string") return record.message;
  if (Array.isArray(record.content)) {
    return record.content.map((part) => typeof part === "string" ? part : (part == null ? void 0 : part.text) || "").join("");
  }
  return "";
}
function parseJsonCandidate(candidate) {
  const trimmed = candidate.trim();
  const a = trimmed.indexOf("[");
  const o = trimmed.indexOf("{");
  const start = a < 0 ? o : o < 0 ? a : Math.min(a, o);
  if (start < 0) return [];
  for (let end = trimmed.length; end > start; end--) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end));
      if (parsed && typeof parsed === "object") {
        return Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (e) {
    }
  }
  return [];
}
function extractJson(text) {
  const source = String(text || "").trim();
  const results = [];
  const tagRegex = /<assistant-scheduler>\s*([\s\S]*?)\s*<\/assistant-scheduler>/gi;
  let tagMatch;
  let foundTag = false;
  while ((tagMatch = tagRegex.exec(source)) !== null) {
    foundTag = true;
    const parsed = parseJsonCandidate(tagMatch[1]);
    if (parsed.length) results.push(...parsed);
  }
  if (foundTag && results.length) return results;
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(source)) !== null) {
    const parsed = parseJsonCandidate(fenceMatch[1]);
    if (parsed.length) return parsed;
  }
  return parseJsonCandidate(source);
}
function isNightlyReviewJob(job) {
  return Boolean(job && job.routine === "daily-review");
}
function isDisabledTask(job) {
  return Boolean(job && !isNightlyReviewJob(job) && !job.enabled && (job.status === "disabled" || job.lastStatus === "disabled"));
}
function taskIdentity(job) {
  return String(job && job.taskNumber || job && job.id || `${job && job.title}
${job && job.prompt}`);
}
function describeBinding(job) {
  return Array.isArray(job && job.contextPaths) && job.contextPaths.length ? "Project-based task" : "Independent task";
}
function summarizeTasks(jobs) {
  const summaries = /* @__PURE__ */ new Map();
  for (const job of jobs) {
    const key = taskIdentity(job);
    const existing = summaries.get(key);
    if (!existing || new Date(job.lastRunAt || job.createdAt || 0) > new Date(existing.lastRunAt || existing.createdAt || 0)) {
      summaries.set(key, job);
    }
  }
  return [...summaries.values()];
}
function logActivityEntry(activity, type, message, jobId = null) {
  activity.push({ id: id("event"), at: (/* @__PURE__ */ new Date()).toISOString(), type, message, jobId });
  if (activity.length > 50) activity.splice(0, activity.length - 50);
}
function sendSystemNotification(title, body) {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return false;
  }
  try {
    if (window.Notification.permission === "granted") {
      new window.Notification(title, { body });
      return true;
    }
    if (window.Notification.permission !== "denied") {
      void window.Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          new window.Notification(title, { body });
        }
      });
      return true;
    }
  } catch (error) {
    console.warn("[ai-scheduler] Native system notification dispatch failed:", error);
  }
  return false;
}
function formatDuration(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "0s";
  const sec = Math.floor(ms / 1e3);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}
function buildTaskLogRow(serial, job, status, outputFiles) {
  var _a;
  const ts = job.lastRunAt ? formatDate(job.lastRunAt) : formatDate((/* @__PURE__ */ new Date()).toISOString());
  const summary = status === "failed" ? "\u274C Failed" : "\u2705 Completed";
  const links = outputFiles.length ? outputFiles.map((p) => `[[${p}]]`).join(", ") : "\u2014";
  const escapedTitle = (job.title || "Untitled").replace(/\|/g, "\\|");
  return `| ${serial} | ${ts} | #${(_a = job.taskNumber) != null ? _a : "?"} ${escapedTitle} | ${summary} | ${links} |`;
}
var TASK_LOG_HEADER = `# AI Scheduler \u2014 Task Log

| # | Timestamp | Task | Status | Modified files |
| --- | --- | --- | --- | --- |`;

// src/schedule.ts
var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var DAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTH_NAMES2 = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function parseClock(value) {
  const str = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 9, minute: 0 };
}
function validClock(value) {
  const str = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(str);
}
function nextDailyRun(time, everyDays = 1, startAt, from = /* @__PURE__ */ new Date()) {
  const clock = parseClock(time);
  const step = Number.isInteger(everyDays) && everyDays > 1 ? everyDays : 1;
  if (startAt) {
    const anchor = new Date(startAt);
    if (!Number.isNaN(anchor.getTime())) {
      anchor.setHours(clock.hour, clock.minute, 0, 0);
      if (anchor > from) return anchor.toISOString();
      const diffDays = Math.floor((from.getTime() - anchor.getTime()) / 864e5);
      const jump = Math.floor(diffDays / step) * step;
      const candidate2 = new Date(anchor.getTime() + jump * 864e5);
      while (candidate2 <= from) {
        candidate2.setDate(candidate2.getDate() + step);
      }
      return candidate2.toISOString();
    }
  }
  const candidate = new Date(from);
  candidate.setHours(clock.hour, clock.minute, 0, 0);
  if (candidate <= from) {
    candidate.setDate(candidate.getDate() + step);
  }
  return candidate.toISOString();
}
function nextWeeklyRun(time, days, everyWeeks = 1, startAt, from = /* @__PURE__ */ new Date()) {
  const clock = parseClock(time);
  const wanted = Array.isArray(days) && days.length ? [...new Set(days.map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b) : [from.getDay()];
  const stepWeeks = Number.isInteger(everyWeeks) && everyWeeks > 1 ? everyWeeks : 1;
  for (let offset = 0; offset <= 7 * stepWeeks * 4; offset++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(clock.hour, clock.minute, 0, 0);
    if (candidate <= from) continue;
    if (wanted.includes(candidate.getDay())) {
      if (stepWeeks > 1 && startAt) {
        const anchor = new Date(startAt);
        if (!Number.isNaN(anchor.getTime())) {
          const diffWeeks = Math.floor((candidate.getTime() - anchor.getTime()) / (7 * 864e5));
          if (diffWeeks >= 0 && diffWeeks % stepWeeks !== 0) continue;
        }
      }
      return candidate.toISOString();
    }
  }
  return nextDailyRun(time, 1, void 0, from);
}
function nextMonthlyRun(time, dayOfMonth = 1, everyMonths = 1, startAt, from = /* @__PURE__ */ new Date()) {
  const clock = parseClock(time);
  const targetDay = Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : 1;
  const stepMonths = Number.isInteger(everyMonths) && everyMonths > 1 ? everyMonths : 1;
  let year = from.getFullYear();
  let month = from.getMonth();
  for (let i = 0; i < 48; i++) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const clampedDay = Math.min(targetDay, daysInMonth);
    const candidate = new Date(year, month, clampedDay, clock.hour, clock.minute, 0, 0);
    if (candidate > from) {
      if (stepMonths > 1 && startAt) {
        const anchor = new Date(startAt);
        if (!Number.isNaN(anchor.getTime())) {
          const monthDiff = (year - anchor.getFullYear()) * 12 + (month - anchor.getMonth());
          if (monthDiff >= 0 && monthDiff % stepMonths !== 0) {
            month += 1;
            if (month > 11) {
              year += Math.floor(month / 12);
              month = month % 12;
            }
            continue;
          }
        }
      }
      return candidate.toISOString();
    }
    month += 1;
    if (month > 11) {
      year += Math.floor(month / 12);
      month = month % 12;
    }
  }
  return nextDailyRun(time, 1, void 0, from);
}
function nextYearlyRun(time, targetMonth = 1, targetDay = 1, from = /* @__PURE__ */ new Date()) {
  const clock = parseClock(time);
  const monthIdx = Number.isInteger(targetMonth) && targetMonth >= 1 && targetMonth <= 12 ? targetMonth - 1 : 0;
  const day = Number.isInteger(targetDay) && targetDay >= 1 && targetDay <= 31 ? targetDay : 1;
  const currentYear = from.getFullYear();
  const daysInMonthThisYear = new Date(currentYear, monthIdx + 1, 0).getDate();
  const candidateThisYear = new Date(currentYear, monthIdx, Math.min(day, daysInMonthThisYear), clock.hour, clock.minute, 0, 0);
  if (candidateThisYear > from) {
    return candidateThisYear.toISOString();
  }
  const nextYear = currentYear + 1;
  const daysInMonthNextYear = new Date(nextYear, monthIdx + 1, 0).getDate();
  const candidateNextYear = new Date(nextYear, monthIdx, Math.min(day, daysInMonthNextYear), clock.hour, clock.minute, 0, 0);
  return candidateNextYear.toISOString();
}
function normalizeMaxIterations(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function normalizeMultiRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => {
    const days = Array.isArray(rule && rule.days) ? rule.days : [];
    const times = Array.isArray(rule && rule.times) ? rule.times : rule && rule.time ? [rule.time] : [];
    return {
      days: [...new Set(days.map(Number).filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b),
      times: [...new Set(times.map((time) => String(time).trim()).filter(validClock))].sort()
    };
  }).filter((rule) => rule.days.length && rule.times.length);
}
function nextMultiRun(rules, from = /* @__PURE__ */ new Date()) {
  const normalized = normalizeMultiRules(rules);
  let next = null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    for (const rule of normalized) {
      if (!rule.days.includes(day.getDay())) continue;
      for (const time of rule.times) {
        const clock = parseClock(time);
        const candidate = new Date(day);
        candidate.setHours(clock.hour, clock.minute, 0, 0);
        if (candidate <= from) continue;
        if (!next || candidate < next) next = candidate;
      }
    }
  }
  return next ? next.toISOString() : null;
}
function parseDayToken(token) {
  const normalized = String(token || "").trim().toLowerCase();
  const exactLong = DAY_NAMES.findIndex((name) => name.toLowerCase() === normalized);
  const exact = exactLong >= 0 ? exactLong : DAY_SHORT_NAMES.findIndex((name) => name.toLowerCase() === normalized);
  if (exact >= 0) return [exact];
  const match = /^([a-z]+)\s*-\s*([a-z]+)$/.exec(normalized);
  if (!match) return [];
  const startLong = DAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(match[1]));
  const start = startLong >= 0 ? startLong : DAY_SHORT_NAMES.findIndex((name) => name.toLowerCase().startsWith(match[1]));
  const endLong = DAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(match[2]));
  const end = endLong >= 0 ? endLong : DAY_SHORT_NAMES.findIndex((name) => name.toLowerCase().startsWith(match[2]));
  if (start < 0 || end < 0) return [];
  const days = [];
  for (let day = start; ; day = (day + 1) % 7) {
    days.push(day);
    if (day === end) break;
  }
  return days;
}
function parseMultiRulesText(value) {
  const source = String(value || "").trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return normalizeMultiRules(parsed);
  } catch (e) {
  }
  const rules = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^(.+?)\s*=\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const days = match[1].split(",").flatMap(parseDayToken);
    const times = match[2].split(",").map((value2) => value2.trim()).filter(validClock);
    rules.push({ days, times });
  }
  return normalizeMultiRules(rules);
}
function formatMultiRules(rules) {
  return normalizeMultiRules(rules).map((rule) => `${rule.days.map((day) => DAY_SHORT_NAMES[day]).join(", ")} = ${rule.times.join(", ")}`).join("\n");
}
function legacyField(schedule, key) {
  return schedule[key];
}
function scheduleMinutes(schedule) {
  if (schedule.kind === "hourly") return 60;
  const minutes = Number(schedule.intervalMinutes || legacyField(schedule, "everyMinutes") || Number(legacyField(schedule, "everyHours") || 0) * 60);
  return Number.isFinite(minutes) ? minutes : NaN;
}
function getScheduleNextRun(schedule, from = /* @__PURE__ */ new Date()) {
  if (!schedule || schedule.kind === "event") return null;
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (schedule.kind === "daily") {
    return validClock(schedule.time) ? nextDailyRun(schedule.time, schedule.everyDays || 1, schedule.startAt, from) : null;
  }
  if (schedule.kind === "weekly") {
    return validClock(schedule.time) ? nextWeeklyRun(schedule.time, schedule.days, schedule.everyWeeks || 1, schedule.startAt, from) : null;
  }
  if (schedule.kind === "monthly") {
    return validClock(schedule.time) ? nextMonthlyRun(schedule.time, schedule.dayOfMonth || 1, schedule.everyMonths || 1, schedule.startAt, from) : null;
  }
  if (schedule.kind === "yearly") {
    return validClock(schedule.time) ? nextYearlyRun(schedule.time, schedule.month || 1, schedule.dayOfMonth || 1, from) : null;
  }
  if (schedule.kind === "multi") return nextMultiRun(schedule.rules, from);
  if (schedule.kind === "hourly" || schedule.kind === "interval") {
    const minutes = scheduleMinutes(schedule);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    if (schedule.startAt) {
      const anchor = new Date(schedule.startAt);
      if (!Number.isNaN(anchor.getTime())) {
        if (anchor > from) return anchor.toISOString();
        const elapsed = from.getTime() - anchor.getTime();
        const steps = Math.floor(elapsed / (minutes * 6e4)) + 1;
        return new Date(anchor.getTime() + steps * minutes * 6e4).toISOString();
      }
    }
    if (schedule.time && validClock(schedule.time)) {
      const clock = parseClock(schedule.time);
      const anchorToday = new Date(from);
      anchorToday.setHours(clock.hour, clock.minute, 0, 0);
      if (anchorToday > from) return anchorToday.toISOString();
      const elapsed = from.getTime() - anchorToday.getTime();
      const steps = Math.floor(elapsed / (minutes * 6e4)) + 1;
      return new Date(anchorToday.getTime() + steps * minutes * 6e4).toISOString();
    }
    return new Date(from.getTime() + minutes * 6e4).toISOString();
  }
  if (schedule.kind === "cron") {
    if (!schedule.expression || validateCron(schedule.expression)) return null;
    const next = cronNext(schedule.expression, from);
    return next ? next.toISOString() : null;
  }
  return validClock(schedule.time) ? nextDailyRun(schedule.time, 1, void 0, from) : null;
}
function cronFormFor(schedule) {
  if (!schedule) return null;
  if (schedule.kind === "cron") return schedule.expression || null;
  if (schedule.kind === "daily" && validClock(schedule.time) && (!schedule.everyDays || schedule.everyDays === 1)) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} * * *`;
  }
  if (schedule.kind === "weekly" && validClock(schedule.time) && (!schedule.everyWeeks || schedule.everyWeeks === 1) && Array.isArray(schedule.days) && schedule.days.length) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} * * ${[...new Set(schedule.days.map(Number))].sort((a, b) => a - b).join(",")}`;
  }
  if (schedule.kind === "monthly" && validClock(schedule.time) && (!schedule.everyMonths || schedule.everyMonths === 1)) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} ${schedule.dayOfMonth || 1} * *`;
  }
  if (schedule.kind === "yearly" && validClock(schedule.time)) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} ${schedule.dayOfMonth || 1} ${schedule.month || 1} *`;
  }
  if (schedule.kind === "multi") {
    const rules = normalizeMultiRules(schedule.rules);
    if (!rules.length) return null;
    const firstTimes = JSON.stringify(rules[0].times);
    if (!rules.every((rule) => JSON.stringify(rule.times) === firstTimes)) return null;
    const days = [...new Set(rules.flatMap((rule) => rule.days))].sort((a, b) => a - b);
    if (!days.length || !rules[0].times.length) return null;
    const clocks = rules[0].times.map(parseClock);
    const minutes = [...new Set(clocks.map((c) => c.minute))];
    if (minutes.length === 1) {
      const hours = [...new Set(clocks.map((c) => c.hour))].sort((a, b) => a - b);
      return `${minutes[0]} ${hours.join(",")} * * ${days.join(",")}`;
    }
    return clocks.map((c) => `${c.minute} ${c.hour} * * ${days.join(",")}`).join("; ");
  }
  return null;
}
function previewSchedule(schedule, count = 3, from = /* @__PURE__ */ new Date()) {
  if (!schedule) return [];
  if (schedule.kind === "event") return ["fires on vault activity"];
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime()) ? [] : [formatLocalRun(date)];
  }
  if (schedule.kind === "cron") {
    if (!schedule.expression || validateCron(schedule.expression)) return [];
    return cronUpcoming(schedule.expression, count, from).map(formatLocalRun);
  }
  const runs = [];
  let cursor = from;
  for (let index = 0; index < count; index++) {
    const next = getScheduleNextRun(schedule, cursor);
    if (!next) break;
    runs.push(formatLocalRun(new Date(next)));
    cursor = new Date(new Date(next).getTime() + 1e3);
  }
  return runs;
}
function describeSchedule(job) {
  const schedule = job.schedule || {};
  let desc = "";
  if (schedule.kind === "daily") {
    if (schedule.everyDays && schedule.everyDays > 1) {
      desc = `every ${schedule.everyDays} days at ${schedule.time || "09:00"}${schedule.startAt ? ` starting ${formatDate(schedule.startAt)}` : ""}`;
    } else {
      desc = `daily at ${schedule.time || "09:00"}`;
    }
  } else if (schedule.kind === "weekly") {
    const days = (schedule.days || []).map(Number).filter((day) => DAY_SHORT_NAMES[day]).map((day) => DAY_SHORT_NAMES[day]);
    if (schedule.everyWeeks && schedule.everyWeeks > 1) {
      desc = `every ${schedule.everyWeeks} weeks on ${days.join(", ") || "selected days"} at ${schedule.time || "09:00"}`;
    } else {
      desc = `weekly on ${days.join(", ") || "selected days"} at ${schedule.time || "09:00"}`;
    }
  } else if (schedule.kind === "monthly") {
    const every = schedule.everyMonths && schedule.everyMonths > 1 ? `every ${schedule.everyMonths} months` : "monthly";
    desc = `${every} on day ${schedule.dayOfMonth || 1} at ${schedule.time || "09:00"}`;
  } else if (schedule.kind === "yearly") {
    const monthName = MONTH_NAMES2[schedule.month || 1] || "January";
    desc = `yearly on ${monthName} ${schedule.dayOfMonth || 1} at ${schedule.time || "09:00"}`;
  } else if (schedule.kind === "multi") {
    desc = formatMultiRules(schedule.rules).replace(/\n/g, " \xB7 ") || "multiple times";
  } else if (schedule.kind === "hourly") {
    desc = `every hour${schedule.time ? ` starting at ${schedule.time}` : ""}`;
  } else if (schedule.kind === "interval") {
    const minutes = Number(schedule.intervalMinutes || legacyField(schedule, "everyMinutes") || Number(legacyField(schedule, "everyHours") || 0) * 60 || 0);
    const cadence = minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `every ${minutes} minutes`;
    desc = `${cadence}${schedule.time ? ` starting at ${schedule.time}` : schedule.startAt ? ` starting ${formatDate(schedule.startAt)}` : ""}`;
  } else if (schedule.kind === "event") {
    desc = `when ${schedule.event || "the vault changes"}`;
  } else if (schedule.kind === "cron") {
    const expression = schedule.expression || "";
    const description = describeCron(expression);
    desc = description === "Invalid cron expression" ? `cron ${expression || "(empty)"}` : `${description} \xB7 ${expression}`;
  } else if (schedule.kind === "once") {
    const at = schedule.at || job.nextRunAt;
    desc = at ? `once at ${formatDate(at)}` : "once (time pending)";
  } else {
    desc = job.nextRunAt ? formatDate(job.nextRunAt) : "not scheduled";
  }
  if (schedule.maxIterations && Number(schedule.maxIterations) > 0) {
    desc += ` \xB7 runs for ${schedule.maxIterations} time${Number(schedule.maxIterations) === 1 ? "" : "s"} then done`;
  }
  return desc;
}
function getScheduleOccurrencesInRange(schedule, start, end, max = 100) {
  if (!schedule || schedule.kind === "event") return [];
  if (schedule.kind === "once") {
    if (!schedule.at) return [];
    const date = new Date(schedule.at);
    if (!Number.isNaN(date.getTime()) && date >= start && date <= end) {
      return [date];
    }
    return [];
  }
  const occurrences = [];
  let cursor = new Date(start.getTime() - 1e3);
  const seen = /* @__PURE__ */ new Set();
  while (occurrences.length < max) {
    const nextIso = getScheduleNextRun(schedule, cursor);
    if (!nextIso) break;
    const nextDate = new Date(nextIso);
    const timeMs = nextDate.getTime();
    if (Number.isNaN(timeMs) || nextDate > end) break;
    if (!seen.has(timeMs)) {
      seen.add(timeMs);
      occurrences.push(nextDate);
    }
    cursor = new Date(Math.max(timeMs + 1e3, cursor.getTime() + 1e3));
  }
  return occurrences;
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  assistantTab: 1,
  backendMode: "claudian",
  planningModel: "",
  executionModel: "",
  dailyReviewModel: "",
  nightlyReviewModel: "",
  reportFolder: "AI Reviews",
  reviewTime: "22:00",
  nightlyReviewEnabled: false,
  notifyOnCompletion: true,
  systemNotifications: true,
  catchUpOnStart: false,
  catchUpHours: 24,
  reviewContextMode: "modified-today",
  scheduleNotesEnabled: false,
  scheduleFolder: "AI Schedules",
  lastSeenVersion: "",
  showChangelogOnUpdate: true,
  defaultOutputFolder: "",
  taskLoggingEnabled: false,
  taskLogFolder: ""
};
var VALID_STATUSES = /* @__PURE__ */ new Set(["scheduled", "running", "completed", "failed", "missed", "disabled"]);
function normalizeOutput(output) {
  if (!output || typeof output !== "object") return null;
  const record = output;
  return {
    folder: typeof record.folder === "string" ? record.folder : void 0,
    filename: typeof record.filename === "string" ? record.filename : void 0
  };
}
function normalizeJob(raw, now = /* @__PURE__ */ new Date()) {
  var _a;
  const scheduleRaw = raw.schedule || (raw.sendAt ? { kind: "once", at: raw.sendAt } : { kind: "once", at: new Date(Date.now() + 6e4).toISOString() });
  const normalizedSchedule = {
    kind: SCHEDULE_KINDS.includes(String(scheduleRaw.kind)) ? scheduleRaw.kind : "once",
    at: typeof scheduleRaw.at === "string" ? scheduleRaw.at : void 0,
    time: typeof scheduleRaw.time === "string" ? scheduleRaw.time : void 0,
    days: Array.isArray(scheduleRaw.days) ? scheduleRaw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : void 0,
    rules: scheduleRaw.rules,
    event: typeof scheduleRaw.event === "string" ? scheduleRaw.event : void 0,
    intervalMinutes: Number.isFinite(Number(scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || Number(scheduleRaw.everyHours || 0) * 60)) ? Number(scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || Number(scheduleRaw.everyHours || 0) * 60) : null,
    maxIterations: normalizeMaxIterationsField(scheduleRaw.maxIterations || scheduleRaw.maxRuns || scheduleRaw.iterations),
    expression: typeof scheduleRaw.expression === "string" ? scheduleRaw.expression : void 0
  };
  const nextRunAt = raw.nextRunAt !== void 0 && (typeof raw.nextRunAt === "string" || raw.nextRunAt === null) ? raw.nextRunAt : getScheduleNextRun(normalizedSchedule, now);
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : raw.enabled === "false" ? false : true;
  const rawStatus = typeof raw.status === "string" ? raw.status : "";
  const status = VALID_STATUSES.has(rawStatus) ? rawStatus : enabled ? "scheduled" : "disabled";
  const attempts = Number(raw.attempts);
  const runCount = Number(raw.runCount);
  const taskNumber = Number(raw.taskNumber);
  const tab = Number(raw.tab);
  const cooldownMinutes = Number(raw.cooldownMinutes);
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : id("job"),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Assistant task",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    tab: Number.isInteger(tab) && tab > 0 ? tab : 1,
    enabled,
    status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
    lastStatus: typeof raw.lastStatus === "string" && VALID_STATUSES.has(raw.lastStatus) ? raw.lastStatus : null,
    lastReply: typeof raw.lastReply === "string" ? raw.lastReply : "",
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    routine: typeof raw.routine === "string" ? raw.routine : null,
    notify: raw.notify !== false,
    output: normalizeOutput(raw.output),
    contextPaths: Array.isArray(raw.contextPaths) ? raw.contextPaths.map(String) : ((_a = raw.context) == null ? void 0 : _a.paths) && Array.isArray(raw.context.paths) ? raw.context.paths.map(String) : [],
    attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : 0,
    runCount: Number.isFinite(runCount) && runCount >= 0 ? runCount : 0,
    taskNumber: Number.isFinite(taskNumber) && taskNumber >= 0 ? taskNumber : 0,
    profile: typeof raw.profile === "string" ? raw.profile : null,
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : null,
    providerId: typeof raw.providerId === "string" ? raw.providerId : null,
    model: typeof raw.model === "string" ? raw.model : null,
    notePath: typeof raw.notePath === "string" ? raw.notePath : null,
    lastOutputPath: typeof raw.lastOutputPath === "string" ? raw.lastOutputPath : null,
    lastOutputFiles: Array.isArray(raw.lastOutputFiles) ? raw.lastOutputFiles.map(String) : void 0,
    cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes >= 0 ? cooldownMinutes : void 0,
    lastEventPath: typeof raw.lastEventPath === "string" ? raw.lastEventPath : void 0,
    source: typeof raw.source === "string" ? raw.source : void 0,
    doubt: typeof raw.doubt === "string" ? raw.doubt : void 0,
    schedule: normalizedSchedule,
    nextRunAt
  };
}
function normalizeMaxIterationsField(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function parseStoredData(data) {
  const stored = data || {};
  const oldSettings = stored.settings || {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, oldSettings);
  const rawBackend = typeof oldSettings.backendMode === "string" ? oldSettings.backendMode : "";
  settings.backendMode = rawBackend === "copilot" ? "copilot" : rawBackend === "claudian" ? "claudian" : rawBackend === "none" ? "none" : DEFAULT_SETTINGS.backendMode;
  const oldDefault = oldSettings.defaultProfile || oldSettings.planningProfile || "";
  settings.planningModel = settings.planningModel || oldSettings.planningProfile || oldDefault;
  settings.executionModel = settings.executionModel || oldDefault;
  settings.dailyReviewModel = settings.dailyReviewModel || oldSettings.nightlyProfile || oldDefault;
  settings.nightlyReviewModel = settings.nightlyReviewModel || oldSettings.nightlyProfile || oldDefault;
  if (!stored.version || stored.version < 3) settings.catchUpOnStart = false;
  const rawCatchUp = Number(settings.catchUpHours);
  settings.catchUpHours = Number.isFinite(rawCatchUp) && rawCatchUp >= 0 ? rawCatchUp : 24;
  const validReviewContextModes = ["modified-today", "all-markdown", "no-files"];
  if (!validReviewContextModes.includes(settings.reviewContextMode)) {
    settings.reviewContextMode = "modified-today";
  }
  if (typeof settings.scheduleNotesEnabled !== "boolean") settings.scheduleNotesEnabled = false;
  if (!settings.scheduleFolder) settings.scheduleFolder = DEFAULT_SETTINGS.scheduleFolder;
  if (typeof settings.showChangelogOnUpdate !== "boolean") settings.showChangelogOnUpdate = true;
  if (typeof settings.lastSeenVersion !== "string") settings.lastSeenVersion = "";
  if (typeof settings.systemNotifications !== "boolean") settings.systemNotifications = true;
  if (typeof settings.defaultOutputFolder !== "string") settings.defaultOutputFolder = "";
  if (typeof settings.taskLoggingEnabled !== "boolean") settings.taskLoggingEnabled = false;
  if (typeof settings.taskLogFolder !== "string") settings.taskLogFolder = "";
  const legacyTasks = stored.tasks;
  const jobs = Array.isArray(stored.jobs) ? stored.jobs.map((job) => normalizeJob(job)) : Array.isArray(legacyTasks) ? legacyTasks.map((task) => normalizeJob({
    ...task,
    title: task.title || "Migrated task",
    prompt: task.prompt || task.content || "",
    schedule: { kind: "once", at: task.sendAt },
    enabled: task.status === "pending"
  })) : [];
  const deletedJobs = Array.isArray(stored.deletedJobs) ? stored.deletedJobs.map((job) => normalizeJob(job)) : [];
  const activity = Array.isArray(stored.activity) ? stored.activity.slice(-50) : [];
  return { settings, jobs, deletedJobs, activity };
}

// src/engine.ts
function dueJobs(jobs, now) {
  return jobs.filter((job) => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now).sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
}
function reconcileAfterRun(job, options = {}) {
  if (job.schedule.kind === "once") {
    job.enabled = false;
    job.nextRunAt = null;
  } else if (job.schedule.kind === "event") {
    job.nextRunAt = null;
  } else if (job.schedule.maxIterations && job.runCount >= Number(job.schedule.maxIterations)) {
    job.enabled = false;
    job.nextRunAt = null;
    if (!options.failed) job.status = "completed";
  } else {
    job.nextRunAt = getScheduleNextRun(job.schedule, /* @__PURE__ */ new Date());
  }
}
function skipMissedJob(job) {
  if (job.schedule.kind === "once") {
    job.enabled = false;
    job.nextRunAt = null;
    job.status = "missed";
    job.lastStatus = "missed";
  } else if (job.schedule.kind === "event") {
    job.nextRunAt = null;
  } else {
    if (job.schedule.maxIterations && job.runCount >= Number(job.schedule.maxIterations)) {
      job.enabled = false;
      job.nextRunAt = null;
      job.status = "completed";
    } else {
      job.nextRunAt = getScheduleNextRun(job.schedule, /* @__PURE__ */ new Date());
    }
  }
}
function planStartupCatchUp(jobs, settings, now) {
  const due = jobs.filter((job) => job.enabled && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now);
  if (!settings.catchUpOnStart) {
    return { missed: [], stale: due };
  }
  const raw = Number(settings.catchUpHours);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 24;
  const cutoff = now - hours * 60 * 60 * 1e3;
  return {
    missed: due.filter((job) => new Date(job.nextRunAt).getTime() >= cutoff),
    stale: due.filter((job) => new Date(job.nextRunAt).getTime() < cutoff)
  };
}
function recoverInterruptedRuns(jobs) {
  let recovered = 0;
  for (const job of jobs) {
    if (job.status !== "running") continue;
    job.status = "scheduled";
    if (job.schedule.kind !== "event" && job.schedule.kind !== "once") {
      const next = getScheduleNextRun(job.schedule, /* @__PURE__ */ new Date());
      if (next) job.nextRunAt = next;
    }
    recovered += 1;
  }
  return recovered;
}
function rescheduleEnabledJob(job) {
  job.nextRunAt = job.schedule.kind === "event" ? (/* @__PURE__ */ new Date()).toISOString() : getScheduleNextRun(job.schedule, new Date(Date.now() - 1e3));
}

// src/prompts.ts
var FOLLOW_UP_INSTRUCTION = 'If this work reveals a concrete future action, you may append at most three follow-up jobs using <assistant-scheduler>[{"title":"...","prompt":"...","schedule":{"kind":"once","at":"ISO-8601"}}]</assistant-scheduler>. Do not create follow-ups unless they are genuinely useful.';
function contextPrompt(prompt, paths) {
  const contextPaths = Array.isArray(paths) ? paths : [];
  if (!contextPaths.length) return prompt;
  return `${prompt}

Selected task context:
${contextPaths.map((path) => `- ${path}`).join("\n")}
Use the attached page/project context and respect the user's backend permissions.`;
}
function executionPrompt(prompt, contextPaths) {
  return `${contextPrompt(prompt, contextPaths)}

${FOLLOW_UP_INSTRUCTION}`;
}
function plannerPrompt(goal, contextPaths) {
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const nowLocal = now.toLocaleString();
  return [
    "You are the planning brain for an autonomous Obsidian AI Scheduler.",
    "Turn the user goal below into one or more safe, concrete automation jobs.",
    `Reference context: Current local time is ${nowLocal} (ISO: ${nowIso}).`,
    "Return ONLY a JSON array inside <assistant-scheduler> tags. No Markdown outside the tags.",
    "Each item MUST have: title, prompt, schedule.",
    '- "title": concise name for the task.',
    '- "prompt": complete, actionable instructions for the AI to execute (never leave prompt empty).',
    '- "doubt": (optional) if there is any ambiguity in user timing or requirements, state your assumption here so the user is notified to confirm.',
    "Schedule rules and natural language time parsing:",
    '- When interpreting times in natural shorthand: e.g. "150" or "150 today" or "at 150" means 1:50 PM (13:50) or 01:50, NOT 15:00. "330" means 3:30 (15:30), "1130" means 11:30, "9" means 09:00.',
    '- For one-time tasks or "today", schedule.kind must be "once" with "at" as an exact ISO-8601 string for that date and time.',
    "schedule must be one of:",
    '- {"kind":"once","at":"ISO-8601 timestamp"}',
    '- {"kind":"daily","time":"HH:MM"}',
    '- {"kind":"weekly","time":"HH:MM","days":[0,1,2,3,4,5,6]}',
    '- {"kind":"multi","rules":[{"days":[1],"times":["02:00"]},{"days":[6],"times":["15:00"]},{"days":[0,2,3,4,5],"times":["01:00","05:00"]}]}',
    '- {"kind":"hourly","maxIterations":8}',
    '- {"kind":"interval","everyMinutes":30,"maxIterations":10}',
    '- {"kind":"interval","everyHours":2,"maxIterations":null}',
    '- {"kind":"event","event":"modify","cooldownMinutes":10}',
    '- {"kind":"cron","expression":"*/15 * * * *"}',
    `Use the user's local time. Add output {"folder":"...","filename":"..."} only when a note should be saved.`,
    `For "cron", the expression must be a standard 5-field cron expression (minute hour day-of-month month day-of-week, 0 = Sunday) evaluated in the user's local time. Prefer the simpler kinds when they can express the pattern; use cron only for advanced cadences such as "every 15 minutes", "weekdays at 9 and 17", or "0 9 * * 1-5". Never invent 6-field expressions.`,
    "A prompt should tell the future agent exactly what to do and what vault context to inspect. Multiple requested schedules must become separate jobs or one multi schedule with rules.",
    `Selected context paths:
${contextPaths.length ? contextPaths.map((path) => `- ${path}`).join("\n") : "- None selected"}`,
    `User goal:
${goal}`
  ].join("\n");
}
function refinePrompt(job, request, contextPaths) {
  return [
    "You are editing an existing AI Scheduler job in Obsidian.",
    "Return ONLY one JSON object inside <assistant-scheduler> tags with title, prompt, and schedule.",
    "Preserve the existing schedule unless the user explicitly asks to change it.",
    `Existing job: ${JSON.stringify({ title: job.title, prompt: job.prompt, schedule: job.schedule })}`,
    `Current context paths: ${JSON.stringify(contextPaths)}`,
    `Requested change: ${request}`
  ].join("\n\n");
}
function reviewPrompt(kind, today, fileList) {
  return [
    `You are the user's ${kind === "nightly" ? "nightly review" : "daily preview"} scheduler inside Obsidian.`,
    `Today is ${today}. Review the user's work from today and produce a useful report.`,
    "Use the active backend's vault tools to read the listed Markdown files before analyzing them. Respect the user's existing permissions and do not access unrelated files.",
    "Do not invent activity. Distinguish facts from suggestions.",
    "Return Markdown only, with these headings: ## Summary, ## Work Completed, ## Important Ideas, ## Open Loops, ## Suggested Next Steps.",
    `Files modified today:
${fileList}`
  ].join("\n\n");
}

// src/context.ts
var import_obsidian = require("obsidian");
function getVaultContextOptions(app) {
  const options = [];
  const files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : [];
  files.forEach((file) => options.push({ path: file.path, label: `Page: ${file.path}`, type: "page" }));
  const loaded = app.vault.getAllLoadedFiles ? app.vault.getAllLoadedFiles() : [];
  loaded.filter((file) => Array.isArray(file.children)).forEach((folder) => {
    if (folder.path) options.push({ path: folder.path, label: `Project folder: ${folder.path}`, type: "project" });
  });
  return options.sort((a, b) => a.path.localeCompare(b.path));
}
function getPathsContext(app, paths) {
  const selected = [...new Set((Array.isArray(paths) ? paths : []).map((path) => (0, import_obsidian.normalizePath)(String(path || "").trim())).filter(Boolean))];
  const available = getVaultContextOptions(app);
  const known = new Set(available.map((option) => option.path));
  const folders = new Set(available.filter((option) => option.type === "project").map((option) => option.path));
  const filePaths = selected.filter((path) => !folders.has(path));
  const folderPaths = selected.filter((path) => folders.has(path));
  const adapter = app.vault.adapter;
  const basePath = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  return {
    paths: selected,
    missingPaths: selected.filter((path) => !known.has(path)),
    linkedContentPath: filePaths[0] || null,
    externalContextPaths: folderPaths.map((path) => basePath ? `${basePath.replace(/[\\/]+$/, "")}/${path}` : path)
  };
}

// src/backends.ts
var import_obsidian2 = require("obsidian");
var AGENT_TIMEOUT_MS = 10 * 60 * 1e3;
function pluginRegistry(host) {
  var _a;
  const app = host.app;
  const registry = (_a = app.plugins) == null ? void 0 : _a.plugins;
  return registry || null;
}
function getClaudianPlugin(host) {
  var _a;
  const plugins = pluginRegistry(host);
  if (!plugins) return null;
  const candidate = (_a = plugins.realclaudian) != null ? _a : plugins.claudian;
  return candidate != null ? candidate : null;
}
async function getClaudianView(host) {
  const claudian = getClaudianPlugin(host);
  if (!claudian) return null;
  let views = typeof claudian.getAllViews === "function" ? claudian.getAllViews() : [];
  if (!views.length && typeof claudian.activateView === "function") {
    try {
      await claudian.activateView();
    } catch (e) {
    }
    await sleep(1200);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    views = typeof claudian.getAllViews === "function" ? claudian.getAllViews() : [];
    if (views[0] && getTabManager(views[0])) return views[0];
    await sleep(500);
  }
  return views[0] || null;
}
function getTabManager(view) {
  if (!view) return null;
  return typeof view.getTabManager === "function" ? view.getTabManager() : view.tabManager || null;
}
function getActiveTab(view, manager) {
  if (view && typeof view.getActiveTab === "function") return view.getActiveTab();
  if (manager && typeof manager.getActiveTab === "function") return manager.getActiveTab();
  return null;
}
function getTab(host, view, number) {
  const manager = getTabManager(view);
  if (!manager) return null;
  const tabs = typeof manager.getAllTabs === "function" ? manager.getAllTabs() : [];
  if (tabs.length) return tabs[Math.max(0, Number(number || 1) - 1)] || null;
  const items = typeof manager.getTabBarItems === "function" ? manager.getTabBarItems() : [];
  const item = items[Math.max(0, Number(number || 1) - 1)];
  return item && typeof manager.getTab === "function" ? manager.getTab(item.id) : null;
}
function tabIsBusy(view, tab) {
  var _a;
  if (!tab) return false;
  const manager = getTabManager(view);
  const items = manager && typeof manager.getTabBarItems === "function" ? manager.getTabBarItems() : [];
  const item = items.find((candidate) => candidate.id === tab.id);
  const working = manager && typeof manager.isTabWorking === "function" ? manager.isTabWorking(tab.id) : false;
  return Boolean(working || ((_a = tab.state) == null ? void 0 : _a.isStreaming) || tab.isStreaming || (item == null ? void 0 : item.isWorking) || (item == null ? void 0 : item.isStreaming));
}
async function waitForTabIdle(view, tab) {
  var _a, _b;
  const started = Date.now();
  while (tabIsBusy(view, tab)) {
    if ((_a = tab == null ? void 0 : tab.state) == null ? void 0 : _a.error) {
      throw new Error(`Claudian reported an error: ${errorText(tab.state.error)}`);
    }
    if (Date.now() - started > AGENT_TIMEOUT_MS) {
      throw new Error(`AI task timed out after ${Math.round(AGENT_TIMEOUT_MS / 6e4)} minutes. The AI backend did not finish or may be waiting for tool execution/confirmation in Claudian.`);
    }
    await sleep(1e3);
  }
  if ((_b = tab == null ? void 0 : tab.state) == null ? void 0 : _b.error) {
    throw new Error(`Claudian reported an error: ${errorText(tab.state.error)}`);
  }
}
function getTabMessages(host, view, tab) {
  var _a;
  const direct = (_a = tab == null ? void 0 : tab.state) == null ? void 0 : _a.messages;
  if (Array.isArray(direct) && direct.length) return direct;
  const conversationId = tab == null ? void 0 : tab.conversationId;
  const claudian = getClaudianPlugin(host);
  const conversation = conversationId && claudian && typeof claudian.getConversationSync === "function" ? claudian.getConversationSync(conversationId) : null;
  return Array.isArray(conversation == null ? void 0 : conversation.messages) ? conversation.messages : [];
}
function lastAssistantReply(host, view, tab, beforeCount) {
  const messages = getTabMessages(host, view, tab);
  const isAssistant = (message2) => {
    if (message2 && typeof message2 === "object" && "role" in message2) {
      return message2.role === "assistant";
    }
    return false;
  };
  const candidates = messages.slice(Math.max(0, beforeCount)).filter(isAssistant);
  const fallback = messages.filter(isAssistant);
  const messagesToUse = candidates.length ? candidates : fallback;
  const message = messagesToUse[messagesToUse.length - 1];
  return contentFromMessage(message).trim();
}
async function sendToClaudian(host, prompt, tabNumber = host.settings.assistantTab, conversationId = null, context = null) {
  var _a;
  const view = await getClaudianView(host);
  const manager = getTabManager(view);
  if (!view || !manager) throw new Error("Claudian is installed but its chat view is not ready. Open the Claudian view once, then try again.");
  if (conversationId && typeof manager.openConversation === "function") {
    await manager.openConversation(conversationId, { preferNewTab: false, activate: true });
    await sleep(300);
  }
  const target = conversationId ? getActiveTab(view, manager) : getTab(host, view, tabNumber);
  if (!target) throw new Error(`Claudian chat ${tabNumber} does not exist.`);
  await waitForTabIdle(view, target);
  const activeId = typeof manager.getActiveTabId === "function" ? manager.getActiveTabId() : manager.activeTabId;
  if (activeId !== target.id && typeof manager.switchToTab === "function") {
    await manager.switchToTab(target.id);
    await sleep(300);
  }
  const active = getActiveTab(view, manager) || target;
  const beforeCount = getTabMessages(host, view, active).length;
  const controller = (_a = active == null ? void 0 : active.controllers) == null ? void 0 : _a.inputController;
  if (!controller || typeof controller.sendMessage !== "function") throw new Error("Claudian input controller is unavailable.");
  const turnRequest = { text: prompt };
  if (context && context.linkedContentPath) turnRequest.linkedContentPath = context.linkedContentPath;
  if (context && context.externalContextPaths && context.externalContextPaths.length) {
    turnRequest.externalContextPaths = context.externalContextPaths;
  }
  const send = controller.sendMessage({ content: prompt, turnRequestOverride: turnRequest });
  await withTimeout(send, AGENT_TIMEOUT_MS, `AI task timed out after ${Math.round(AGENT_TIMEOUT_MS / 6e4)} minutes`);
  await waitForTabIdle(view, active);
  await sleep(300);
  return lastAssistantReply(host, view, active, beforeCount);
}
function getCopilotPlugin(host) {
  var _a;
  const plugins = pluginRegistry(host);
  if (!plugins) return null;
  const candidate = (_a = plugins.copilot) != null ? _a : plugins["obsidian-copilot"];
  return candidate != null ? candidate : null;
}
async function sendToCopilot(host, prompt, context = null) {
  const copilot = getCopilotPlugin(host);
  const chatManager = copilot == null ? void 0 : copilot.chatManager;
  const chain = (copilot == null ? void 0 : copilot.chainOwner) && typeof copilot.chainOwner.getCurrentChainManager === "function" ? copilot.chainOwner.getCurrentChainManager() : null;
  if (!copilot) throw new Error("Obsidian Copilot is not installed or enabled. Install or enable Copilot, then try again.");
  if (!chatManager || typeof chatManager.sendMessage !== "function" || typeof chatManager.getLLMMessage !== "function" || !chain || typeof chain.runChain !== "function") {
    throw new Error("Obsidian Copilot is installed, but its automation API is unavailable. Update Copilot and try again.");
  }
  const paths = context && Array.isArray(context.paths) ? context.paths : [];
  const notes = paths.map((path) => host.app.vault.getAbstractFileByPath(path)).filter((file) => file instanceof import_obsidian2.TFile);
  const folders = paths.map((path) => host.app.vault.getAbstractFileByPath(path)).filter((file) => file instanceof import_obsidian2.TFolder).map((folder) => folder.path);
  const messageId = await chatManager.sendMessage(
    prompt,
    { notes, urls: [], folders, selectedTextContexts: [], webTabs: [] },
    "llm_chain",
    false,
    false
  );
  const llmMessage = chatManager.getLLMMessage(messageId);
  if (!llmMessage) throw new Error("Obsidian Copilot did not prepare the scheduler message.");
  let reply = "";
  const run = chain.runChain(
    llmMessage,
    new AbortController(),
    (message) => {
      reply = typeof message === "string" ? message : contentFromMessage(message) || reply;
    },
    (message) => {
      reply = contentFromMessage(message) || reply;
    },
    { debug: false }
  );
  await withTimeout(run, AGENT_TIMEOUT_MS, "AI task timed out after 30 minutes");
  return (reply || "").trim();
}
function sendToAI(host, prompt, execution = {}, context = null) {
  return host.settings.backendMode === "copilot" ? sendToCopilot(host, prompt, context) : sendToClaudian(host, prompt, execution.tab, execution.conversationId || null, context);
}
function getProviderName(providerId) {
  const names = {
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    opencode: "OpenCode",
    pi: "Pi",
    acp: "ACP"
  };
  if (providerId && providerId in names) {
    return names[providerId];
  }
  return providerId || "Claudian";
}
function modelValue(providerId, model) {
  return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || "" }))}`;
}
function parseProfileValue(value) {
  if (!String(value || "").startsWith("profile:")) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value).slice(8)));
    if (parsed && typeof parsed === "object" && "providerId" in parsed) {
      const record = parsed;
      if (typeof record.providerId === "string") {
        return {
          providerId: record.providerId,
          model: typeof record.model === "string" ? record.model : void 0
        };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
function getClaudianViewSync(host) {
  const claudian = getClaudianPlugin(host);
  return claudian && typeof claudian.getAllViews === "function" ? claudian.getAllViews()[0] || null : null;
}
function getModelOptions(host) {
  var _a;
  const profiles = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (profile) => {
    if (!profile || !profile.providerId) return;
    const key = `${profile.providerId}
${profile.model || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    profiles.push(profile);
  };
  const view = getClaudianViewSync(host);
  const manager = getTabManager(view);
  const claudian = getClaudianPlugin(host);
  const tabs = manager && typeof manager.getAllTabs === "function" ? manager.getAllTabs() : [];
  tabs.forEach((tab) => {
    var _a2;
    const conversation = tab.conversationId && claudian && typeof claudian.getConversationSync === "function" ? claudian.getConversationSync(tab.conversationId) : null;
    const providerId = conversation == null ? void 0 : conversation.providerId;
    if (providerId && (conversation == null ? void 0 : conversation.selectedModel)) add({
      value: modelValue(providerId, conversation.selectedModel),
      label: `${getProviderName(providerId)} / ${conversation.selectedModel}`,
      providerId,
      model: conversation.selectedModel
    });
    const modelSelector = (_a2 = tab.ui) == null ? void 0 : _a2.modelSelector;
    if (providerId && modelSelector && typeof modelSelector.getAvailableModels === "function") {
      try {
        modelSelector.getAvailableModels().forEach((option) => add({
          value: modelValue(providerId, option.value),
          label: `${getProviderName(providerId)} / ${option.label || option.value}`,
          providerId,
          model: option.value
        }));
      } catch (e) {
      }
    }
  });
  const settings = (claudian == null ? void 0 : claudian.settings) || ((_a = claudian == null ? void 0 : claudian.providerHost) == null ? void 0 : _a.settings);
  const savedModels = (settings == null ? void 0 : settings.savedProviderModel) || {};
  const last = settings == null ? void 0 : settings.lastSelectedChatModel;
  if (last && last.providerId) add({
    value: modelValue(last.providerId, last.model),
    label: `${getProviderName(last.providerId)} / ${last.model || "default model"}`,
    providerId: last.providerId,
    model: last.model || ""
  });
  Object.entries(savedModels).forEach(([providerId, model]) => add({
    value: modelValue(providerId, model),
    label: `${getProviderName(providerId)} / ${model || "default model"}`,
    providerId,
    model: model || ""
  }));
  const settingsProvider = settings == null ? void 0 : settings.settingsProvider;
  const settingsModel = settingsProvider ? savedModels[settingsProvider] || (settings == null ? void 0 : settings.model) : void 0;
  if (settingsProvider) add({
    value: modelValue(settingsProvider, settingsModel),
    label: `${getProviderName(settingsProvider)} / ${settingsModel || "current model"}`,
    providerId: settingsProvider,
    model: settingsModel || ""
  });
  return profiles;
}
async function refreshModels(host) {
  const view = await getClaudianView(host);
  if (!view || !getTabManager(view)) {
    throw new Error("Claudian is not ready. Open Claudian once, then refresh the model list.");
  }
  return getModelOptions(host);
}
function checkCopilotSetup(host) {
  const info = BACKEND_INFO.copilot;
  const copilot = getCopilotPlugin(host);
  if (!copilot) return { ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl };
  let chain = null;
  try {
    chain = copilot.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === "function" ? copilot.chainOwner.getCurrentChainManager() : null;
  } catch (e) {
    chain = null;
  }
  if (!copilot.chatManager || typeof copilot.chatManager.sendMessage !== "function" || typeof copilot.chatManager.getLLMMessage !== "function" || !chain || typeof chain.runChain !== "function") {
    return { ok: false, needsInstall: false, message: `${info.name} is installed, but its automation API is unavailable. Update Copilot.`, githubUrl: info.githubUrl };
  }
  return { ok: true, needsInstall: false, message: `${info.name} is ready. Its active Copilot model will be used.`, githubUrl: info.githubUrl };
}
async function checkClaudianSetup(host) {
  const info = BACKEND_INFO.claudian;
  const claudian = getClaudianPlugin(host);
  if (!claudian) return { ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl };
  const view = await getClaudianView(host);
  const manager = getTabManager(view);
  if (!view || !manager) return { ok: false, needsInstall: false, message: `${info.name} is installed, but its chat runtime is not ready. Open Claudian once and try again.`, githubUrl: info.githubUrl };
  const models = getModelOptions(host);
  if (!models.some((model) => model.providerId)) return { ok: false, needsInstall: false, message: `${info.name} is open, but no provider/model is configured.`, githubUrl: info.githubUrl };
  return { ok: true, needsInstall: false, message: `${info.name} is ready with ${models.length} available model option${models.length === 1 ? "" : "s"}.`, githubUrl: info.githubUrl };
}
function checkBackendSetup(host, mode = host.settings.backendMode) {
  if (mode === "none" || !mode) {
    return { ok: false, needsInstall: false, message: "Please select an AI backend in AI Scheduler settings.", githubUrl: "" };
  }
  return mode === "copilot" ? checkCopilotSetup(host) : checkClaudianSetup(host);
}
async function resolveModel(host, value, action = "this action") {
  if (host.settings.backendMode === "none" || !host.settings.backendMode) {
    throw new Error(`No AI backend selected for ${action}. Choose Claudian or Obsidian Copilot in AI Scheduler settings.`);
  }
  if (host.settings.backendMode === "copilot") {
    const setup = checkCopilotSetup(host);
    if (!setup.ok) {
      const installHint = setup.needsInstall ? ` Install it from ${setup.githubUrl}.` : "";
      throw new Error(`${setup.message}${installHint} It is the active AI Scheduler backend for ${action}.`);
    }
    return { modelRef: "copilot", tab: null, conversationId: null, providerId: "copilot", model: null };
  }
  const selected = typeof value === "string" && value.trim() ? value.trim() : (host.settings.executionModel || "").trim();
  if (!selected) {
    throw new Error(`No model selected for ${action}. Choose a model in AI Scheduler settings first.`);
  }
  if (!getClaudianPlugin(host)) {
    const info = BACKEND_INFO.claudian;
    throw new Error(`${info.name} is not installed or enabled. Install it from ${info.githubUrl}. It is required for ${action}.`);
  }
  const availableModels = getModelOptions(host);
  if (!availableModels.some((model) => model.value === selected)) {
    throw new Error(`The selected model for ${action} is no longer available in Claudian. Refresh the model list and choose another model.`);
  }
  const profile = parseProfileValue(selected);
  if (!profile || !profile.providerId) {
    throw new Error(`The selected model configuration for ${action} is invalid.`);
  }
  const claudian = getClaudianPlugin(host);
  if (!claudian) throw new Error(`Claudian is not installed or enabled. It is required for ${action}.`);
  if (typeof claudian.createConversation !== "function") throw new Error(`Claudian cannot create a conversation for ${action}.`);
  let conversation;
  try {
    conversation = await claudian.createConversation({
      providerId: profile.providerId,
      ...profile.model ? { selectedModel: profile.model } : {}
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Claudian could not create the selected model for ${action}: ${message}`);
  }
  if (!conversation || !conversation.id) throw new Error(`Claudian returned no conversation for ${action}.`);
  if (conversation.id && typeof claudian.renameConversation === "function") {
    await claudian.renameConversation(conversation.id, "AI Scheduler - Planning");
  }
  return { modelRef: selected, tab: host.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
}
async function resolveJobExecution(host, job) {
  const selectedModel = job.routine === "daily-review" ? host.settings.nightlyReviewModel : host.settings.executionModel;
  const action = job.routine === "daily-review" ? "nightly review" : "scheduled task execution";
  return resolveModel(host, selectedModel, action);
}

// src/ui/AssistantModal.ts
var import_obsidian8 = require("obsidian");

// src/ui/dom.ts
function makeButton(parent, label, onClick, primary = false, danger = false) {
  const button = parent.createEl("button", { text: label });
  if (primary) button.addClass("mod-cta");
  if (danger) button.addClass("ai-scheduler-button-danger");
  button.onclick = () => {
    void onClick(button);
  };
  return button;
}
function makeCard(parent, ...extraClasses) {
  const card = parent.createDiv();
  card.addClass("ai-scheduler-card");
  for (const extra of extraClasses) card.addClass(extra);
  return card;
}
function closeExistingSchedulerModals(currentModal) {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".ai-scheduler-modal").forEach((el) => {
    if (currentModal && currentModal.modalEl && (el === currentModal.modalEl || el.contains(currentModal.modalEl))) {
      return;
    }
    const container = el.closest(".modal-container");
    if (container && currentModal && currentModal.contentEl && container.contains(currentModal.contentEl)) {
      return;
    }
    if (container) {
      const closeBtn = container.querySelector(".modal-close-button");
      if (closeBtn) closeBtn.click();
      else container.remove();
    }
  });
}

// src/ui/JobModal.ts
var import_obsidian4 = require("obsidian");

// src/ui/contextPicker.ts
var import_obsidian3 = require("obsidian");
var FilePickerModal = class extends import_obsidian3.FuzzySuggestModal {
  constructor(app, onChosen) {
    super(app);
    this.onChosen = onChosen;
    this.setPlaceholder("Type to search files or notes to attach...");
  }
  getItems() {
    return this.app.vault.getFiles().filter((f) => !f.path.startsWith("."));
  }
  getItemText(item) {
    return item.path;
  }
  onChooseItem(item) {
    this.onChosen(item);
  }
};
var FolderPickerModal = class extends import_obsidian3.FuzzySuggestModal {
  constructor(app, onChosen) {
    super(app);
    this.onChosen = onChosen;
    this.setPlaceholder("Type to search vault folders to attach...");
  }
  getItems() {
    const folders = [];
    const scan = (folder) => {
      folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof import_obsidian3.TFolder) scan(child);
      }
    };
    const root = this.app.vault.getRoot();
    if (root) scan(root);
    return folders.filter((f) => f.path && f.path !== "/" && !f.path.startsWith("."));
  }
  getItemText(item) {
    return `${item.path}/`;
  }
  onChooseItem(item) {
    this.onChosen(item);
  }
};
function createContextPicker(parent, options, initialPaths, app) {
  const card = makeCard(parent, "ai-scheduler-card-flush");
  const header = card.createDiv({ cls: "ai-scheduler-context-header" });
  header.createDiv({ cls: "ai-scheduler-form-label", text: "\u{1F4CE} Context & Attachments for this task" });
  header.createDiv({
    cls: "ai-scheduler-hint",
    text: "Attached notes and folders will be inspected and referenced by the AI when executing this task."
  });
  const pathsSet = new Set(initialPaths);
  const chipsContainer = card.createDiv({ cls: "ai-scheduler-context-chips" });
  const renderChips = () => {
    chipsContainer.empty();
    if (pathsSet.size === 0) {
      chipsContainer.createDiv({
        cls: "ai-scheduler-context-empty",
        text: "No attachments yet. Type @ in the prompt above to mention notes, or use the attach buttons below."
      });
      return;
    }
    pathsSet.forEach((path) => {
      const isFolder = path.endsWith("/") || !path.includes(".");
      const chip = chipsContainer.createDiv({ cls: "ai-scheduler-context-chip" });
      chip.createSpan({ cls: "ai-scheduler-chip-icon", text: isFolder ? "\u{1F4C1}" : "\u{1F4C4}" });
      chip.createSpan({ cls: "ai-scheduler-chip-text", text: path });
      const removeBtn = chip.createSpan({ cls: "ai-scheduler-chip-remove", text: "\u2715" });
      removeBtn.setAttribute("title", "Remove attachment");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pathsSet.delete(path);
        renderChips();
      });
    });
  };
  renderChips();
  const controls = card.createDiv({ cls: "ai-scheduler-picker-controls" });
  makeButton(controls, "Attach file...", () => {
    new FilePickerModal(app, (file) => {
      pathsSet.add(file.path);
      renderChips();
      new import_obsidian3.Notice(`Attached: ${file.path}`);
    }).open();
  });
  makeButton(controls, "Attach active note", () => {
    const active = app.workspace.getActiveFile();
    if (!active) {
      new import_obsidian3.Notice("No active note is currently open in Obsidian.");
      return;
    }
    pathsSet.add(active.path);
    renderChips();
    new import_obsidian3.Notice(`Attached active note: ${active.path}`);
  });
  makeButton(controls, "Attach folder...", () => {
    new FolderPickerModal(app, (folder) => {
      const normPath = `${folder.path}/`;
      pathsSet.add(normPath);
      renderChips();
      new import_obsidian3.Notice(`Attached folder: ${normPath}`);
    }).open();
  });
  makeButton(controls, "Clear all", () => {
    pathsSet.clear();
    renderChips();
  });
  return {
    getPaths: () => Array.from(pathsSet),
    addPath: (path) => {
      pathsSet.add(path);
      renderChips();
    },
    removePath: (path) => {
      pathsSet.delete(path);
      renderChips();
    }
  };
}

// src/ui/mentionSuggest.ts
function attachMentionSuggest(options) {
  const { textarea, app, onSelect } = options;
  let popup = null;
  let selectedIndex = 0;
  let matches = [];
  let queryStartIndex = -1;
  const removePopup = () => {
    if (popup) {
      popup.remove();
      popup = null;
    }
    matches = [];
    selectedIndex = 0;
    queryStartIndex = -1;
  };
  const getVaultFiles = (query) => {
    const q = query.toLowerCase().trim();
    const all = app.vault.getFiles().filter((f) => !f.path.startsWith("."));
    if (!q) {
      return all.slice(0, 10);
    }
    const filtered = all.filter(
      (f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    );
    filtered.sort((a, b) => {
      const aBase = a.basename.toLowerCase();
      const bBase = b.basename.toLowerCase();
      if (aBase === q) return -1;
      if (bBase === q) return 1;
      if (aBase.startsWith(q) && !bBase.startsWith(q)) return -1;
      if (!aBase.startsWith(q) && bBase.startsWith(q)) return 1;
      return a.path.localeCompare(b.path);
    });
    return filtered.slice(0, 10);
  };
  const insertSelection = (file) => {
    if (queryStartIndex < 0) return;
    const text = textarea.value;
    const cursor = textarea.selectionStart;
    const before = text.slice(0, queryStartIndex);
    const after = text.slice(cursor);
    const mentionText = `[[${file.basename}]]`;
    textarea.value = `${before}${mentionText} ${after}`;
    const nextCursor = before.length + mentionText.length + 1;
    textarea.setSelectionRange(nextCursor, nextCursor);
    textarea.focus();
    removePopup();
    if (onSelect) {
      onSelect(file);
    }
  };
  const renderPopup = () => {
    if (!matches.length) {
      removePopup();
      return;
    }
    if (!popup) {
      const parent = textarea.parentElement || document.body;
      if (window.getComputedStyle(parent).position === "static") {
        parent.addClass("ai-scheduler-mention-container");
      }
      popup = parent.createDiv({ cls: "ai-scheduler-mention-popup" });
    }
    popup.empty();
    const header = popup.createDiv({ cls: "ai-scheduler-mention-header" });
    header.createSpan({ text: "\u{1F4C4} Vault files (press Enter to attach)" });
    const list = popup.createDiv({ cls: "ai-scheduler-mention-list" });
    matches.forEach((file, index) => {
      const item = list.createDiv({
        cls: `ai-scheduler-mention-item ${index === selectedIndex ? "is-selected" : ""}`
      });
      item.createSpan({ cls: "ai-scheduler-mention-icon", text: "\u{1F4C4}" });
      const info = item.createDiv({ cls: "ai-scheduler-mention-info" });
      info.createDiv({ cls: "ai-scheduler-mention-name", text: file.basename });
      if (file.parent && file.parent.path && file.parent.path !== "/") {
        info.createDiv({ cls: "ai-scheduler-mention-path", text: file.parent.path });
      }
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insertSelection(file);
      });
    });
    const selectedEl = list.children[selectedIndex];
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  };
  const onInput = () => {
    const cursor = textarea.selectionStart;
    const text = textarea.value.slice(0, cursor);
    const atMatch = text.match(/@([^\s@]*)$/);
    if (atMatch && atMatch.index !== void 0) {
      queryStartIndex = atMatch.index;
      const query = atMatch[1];
      matches = getVaultFiles(query);
      selectedIndex = 0;
      renderPopup();
    } else {
      removePopup();
    }
  };
  const onKeyDown = (e) => {
    if (!popup || !matches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % matches.length;
      renderPopup();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
      renderPopup();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (matches[selectedIndex]) {
        e.preventDefault();
        insertSelection(matches[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      removePopup();
    }
  };
  const onBlur = () => {
    window.setTimeout(() => {
      removePopup();
    }, 200);
  };
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeyDown);
  textarea.addEventListener("blur", onBlur);
  return () => {
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("keydown", onKeyDown);
    textarea.removeEventListener("blur", onBlur);
    removePopup();
  };
}

// src/ui/JobModal.ts
var KIND_LABELS = {
  once: "Once at a specific time",
  daily: "Daily / Every N days",
  weekly: "Weekly / Every N weeks",
  monthly: "Monthly / Every N months",
  yearly: "Yearly / Every year",
  multi: "Multiple weekday/time rules",
  hourly: "Every hour",
  interval: "Every N minutes / hours",
  event: "When the vault changes",
  cron: "Cron expression (advanced)"
};
var JobModal = class extends import_obsidian4.Modal {
  constructor(app, plugin, job, onSaved) {
    super(app);
    this.editMode = "manual";
    this.scheduleInputs = { dayChecks: [] };
    this.kindSelect = null;
    this.plugin = plugin;
    this.job = job;
    this.onSaved = onSaved;
    this.kind = job.schedule.kind;
  }
  onOpen() {
    closeExistingSchedulerModals(this);
    this.render();
  }
  render() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-sm");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: "ai-scheduler-shell ai-scheduler-shell-tight" });
    const navBar = shell.createDiv({ cls: "ai-scheduler-modal-nav" });
    const backBtn = navBar.createEl("button", {
      cls: "ai-scheduler-back-btn",
      text: "\u2190 back to dashboard"
    });
    backBtn.onclick = () => {
      this.close();
      if (this.onSaved) {
        window.setTimeout(() => this.onSaved(), 50);
      } else {
        window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
      }
    };
    shell.createEl("h2", { text: `Edit Task #${this.job.taskNumber}` });
    shell.createEl("p", { text: "Choose to edit the schedule and prompt manually, or ask AI to rewrite them for you.", cls: "ai-scheduler-subtitle" });
    const switcher = shell.createDiv({ cls: "ai-scheduler-tab-switcher" });
    const manualBtn = switcher.createEl("button", {
      cls: `ai-scheduler-tab-btn ${this.editMode === "manual" ? "is-active" : ""}`,
      text: "Edit manually"
    });
    const aiBtn = switcher.createEl("button", {
      cls: `ai-scheduler-tab-btn ${this.editMode === "ai" ? "is-active" : ""}`,
      text: "Edit with AI"
    });
    manualBtn.onclick = () => {
      if (this.editMode !== "manual") {
        this.editMode = "manual";
        this.render();
      }
    };
    aiBtn.onclick = () => {
      if (this.editMode !== "ai") {
        this.editMode = "ai";
        this.render();
      }
    };
    if (this.editMode === "manual") {
      this.renderManualMode(shell);
    } else {
      this.renderAiMode(shell);
    }
  }
  renderManualMode(shell) {
    if (this.job.doubt) {
      const doubtBanner = shell.createDiv({ cls: "ai-scheduler-alert-banner ai-scheduler-gap-8" });
      const content = doubtBanner.createDiv({ cls: "ai-scheduler-alert-content" });
      content.createSpan({ cls: "ai-scheduler-alert-icon", text: "\u{1F4A1}" });
      const textCol = content.createDiv();
      textCol.createDiv({ cls: "ai-scheduler-alert-title", text: "AI Planning Note & Unspecified Details" });
      textCol.createDiv({ cls: "ai-scheduler-alert-desc", text: `${this.job.doubt} Default values were populated for any unspecified details. Please check the fields marked with * below.` });
    }
    const detailsCard = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
    const detailsHeader = detailsCard.createDiv({ cls: "ai-scheduler-task-header ai-scheduler-gap-8" });
    detailsHeader.createDiv({ cls: "ai-scheduler-lead", text: "Task Details" });
    const idBadge = detailsHeader.createSpan({ cls: "ai-scheduler-task-id-badge", text: `ID: ${this.job.id}` });
    idBadge.setAttribute("title", "Click to copy task ID");
    idBadge.onclick = (e) => {
      e.stopPropagation();
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(this.job.id).then(() => {
          new import_obsidian4.Notice(`Copied Task ID: ${this.job.id}`);
        });
      }
    };
    const titleLabel = detailsCard.createDiv({ cls: "ai-scheduler-form-label" });
    titleLabel.createSpan({ text: "Task title" });
    titleLabel.createSpan({ cls: "ai-scheduler-required-asterisk", text: " *" });
    const titleInput = detailsCard.createEl("input", {
      type: "text",
      placeholder: "Task title...",
      cls: "ai-scheduler-input ai-scheduler-form-gap"
    });
    titleInput.value = this.job.title || "";
    const promptLabel = detailsCard.createDiv({ cls: "ai-scheduler-form-label" });
    promptLabel.createSpan({ text: "Prompt & instructions" });
    promptLabel.createSpan({ cls: "ai-scheduler-required-asterisk", text: " *" });
    const promptInput = detailsCard.createEl("textarea", {
      placeholder: "Instructions for the AI when executing this task (type @ to attach files)...",
      cls: "ai-scheduler-textarea ai-scheduler-form-gap"
    });
    promptInput.value = this.job.prompt || "";
    attachMentionSuggest({
      textarea: promptInput,
      app: this.app,
      onSelect: (file) => {
        contextPicker.addPath(file.path);
        new import_obsidian4.Notice(`Attached to context: ${file.path}`);
      }
    });
    this.renderScheduleEditor(shell);
    const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
    shell.createDiv({ cls: "ai-scheduler-form-label", text: "Result folder for this task (optional)" });
    const resultFolder = shell.createEl("input", {
      type: "text",
      placeholder: "Optional result folder, e.g. Projects/News",
      cls: "ai-scheduler-input ai-scheduler-form-gap"
    });
    resultFolder.value = this.job.output && this.job.output.folder || "";
    const footer = shell.createDiv({ cls: "ai-scheduler-footer-wrap" });
    makeButton(footer, "Cancel", () => this.close());
    makeButton(footer, "Save schedule changes", async () => {
      try {
        const state = this.readEditorState();
        const validation = this.validateState(state);
        if (validation) {
          new import_obsidian4.Notice(validation, 8e3);
          return;
        }
        const folder = resultFolder.value.trim();
        const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
        const newTitle = titleInput.value.trim() || this.job.title;
        const newPrompt = promptInput.value.trim() || this.job.prompt;
        await this.plugin.updateJob(this.job, {
          title: newTitle,
          prompt: newPrompt,
          schedule: state.schedule,
          contextPaths: contextPicker.getPaths(),
          output,
          cooldownMinutes: state.cooldownMinutes
        });
        new import_obsidian4.Notice("Schedule updated and saved.", 6e3);
        this.onSaved();
        this.close();
      } catch (error) {
        new import_obsidian4.Notice(`Could not update task: ${errorText(error)}`, 8e3);
      }
    }, true);
  }
  renderAiMode(shell) {
    const aiSection = makeCard(shell, "ai-scheduler-card-ai");
    aiSection.createDiv({ cls: "ai-scheduler-lead ai-scheduler-gap-6", text: "Describe what you want to change" });
    aiSection.createDiv({
      cls: "ai-scheduler-hint ai-scheduler-gap-8",
      text: 'Example: "Change time to 1:50 PM every weekday", "Add daily summary notes folder", or "Rewrite instructions to check recent meetings".'
    });
    const readiness = this.plugin.getBackendReadiness();
    if (!readiness.ok) {
      const banner = aiSection.createDiv({ cls: "ai-scheduler-alert-banner" });
      const content = banner.createDiv({ cls: "ai-scheduler-alert-content" });
      content.createSpan({ cls: "ai-scheduler-alert-icon", text: "\u26A0\uFE0F" });
      const textCol = content.createDiv();
      textCol.createDiv({ cls: "ai-scheduler-alert-title", text: "AI backend not configured" });
      textCol.createDiv({ cls: "ai-scheduler-alert-desc", text: readiness.message });
      const btn = banner.createEl("button", { text: "Open settings", cls: "mod-cta ai-scheduler-alert-btn" });
      btn.onclick = () => {
        this.close();
        window.setTimeout(() => {
          this.plugin.openSettingsTab();
        }, 50);
      };
    }
    const request = aiSection.createEl("textarea", {
      placeholder: "Describe your requested change (type @ to attach files)...",
      cls: "ai-scheduler-textarea ai-scheduler-textarea-ai"
    });
    const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
    attachMentionSuggest({
      textarea: request,
      app: this.app,
      onSelect: (file) => {
        contextPicker.addPath(file.path);
        new import_obsidian4.Notice(`Attached to context: ${file.path}`);
      }
    });
    shell.createDiv({ cls: "ai-scheduler-form-label", text: "Result folder for this task (optional)" });
    const resultFolder = shell.createEl("input", {
      type: "text",
      placeholder: "Optional result folder, e.g. Projects/News",
      cls: "ai-scheduler-input ai-scheduler-form-gap"
    });
    resultFolder.value = this.job.output && this.job.output.folder || "";
    const footer = shell.createDiv({ cls: "ai-scheduler-footer-wrap" });
    makeButton(footer, "Cancel", () => this.close());
    makeButton(footer, "Update task with AI", async (button) => {
      const change = request.value.trim();
      if (!change) {
        new import_obsidian4.Notice("Describe the task change first.");
        return;
      }
      button.disabled = true;
      button.setText("AI is updating...");
      try {
        const contextPaths = contextPicker.getPaths();
        const plan = await this.plugin.refineJob(this.job, change, contextPaths);
        const schedule = plan.schedule || this.job.schedule;
        if (schedule.kind !== "event" && !getScheduleNextRun(schedule, new Date(Date.now() - 1e3))) {
          throw new Error("AI returned an invalid schedule. Ask for a concrete time or cadence.");
        }
        const folder = resultFolder.value.trim();
        const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
        await this.plugin.updateJob(this.job, {
          title: String(plan.title).trim(),
          prompt: String(plan.prompt).trim(),
          schedule,
          contextPaths,
          output
        });
        new import_obsidian4.Notice("AI updated and saved the scheduled task.", 6e3);
        this.onSaved();
        this.close();
      } catch (error) {
        new import_obsidian4.Notice(`Could not update task: ${errorText(error)}`, 8e3);
        button.disabled = false;
        button.setText("Update task with AI");
      }
    }, true);
  }
  /* Manual schedule editor: one dynamic field group per kind, with a live
   * next-runs preview. Cron expressions are validated on every keystroke. */
  renderScheduleEditor(shell) {
    const card = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
    card.createDiv({ cls: "ai-scheduler-lead ai-scheduler-gap-8", text: "Schedule" });
    const kindRow = card.createDiv("ai-scheduler-kind-row");
    this.kindSelect = kindRow.createEl("select");
    SCHEDULE_KINDS.forEach((option) => {
      const element = this.kindSelect.createEl("option", { value: option, text: KIND_LABELS[option] });
      element.selected = option === this.kind;
    });
    const fields = card.createDiv();
    const preview = card.createDiv("ai-scheduler-preview");
    const rerenderFields = () => {
      fields.empty();
      this.scheduleInputs = { dayChecks: [] };
      this.renderKindFields(fields, () => this.updatePreview(preview));
      this.updatePreview(preview);
    };
    this.kindSelect.onchange = () => {
      this.kind = this.kindSelect.value;
      rerenderFields();
    };
    rerenderFields();
  }
  updatePreview(preview) {
    preview.empty();
    const state = this.readEditorState();
    const schedule = state.schedule;
    if (schedule.kind === "cron" && schedule.expression) {
      const error = validateCron(schedule.expression);
      if (error) {
        preview.createDiv({ text: error }).addClass("ai-scheduler-preview-error");
        return;
      }
    }
    if (schedule.kind === "event") {
      preview.setText("Runs when the vault changes, after a cooldown.");
      return;
    }
    const runs = previewSchedule(schedule, 3);
    if (!runs.length) {
      preview.setText("No upcoming runs with the current values.");
      return;
    }
    preview.setText(`Next runs: ${runs.join("  \xB7  ")}`);
  }
  renderKindFields(container, onChange) {
    var _a;
    const schedule = this.job.schedule;
    const createLabel = (text, required = false) => {
      const label = container.createDiv("ai-scheduler-field-label");
      label.createSpan({ text });
      if (required) {
        label.createSpan({ cls: "ai-scheduler-required-asterisk", text: " *" });
      }
      return label;
    };
    const createInput = (attributes) => {
      const element = container.createEl("input", { type: attributes.type || "text" });
      if (attributes.value !== void 0) element.value = attributes.value;
      if (attributes.min !== void 0) element.min = attributes.min;
      if (attributes.max !== void 0) element.max = attributes.max;
      if (attributes.placeholder !== void 0) element.placeholder = attributes.placeholder;
      element.addClass("ai-scheduler-input");
      if (attributes.monospace) element.addClass("ai-scheduler-input-mono");
      element.oninput = onChange;
      return element;
    };
    switch (this.kind) {
      case "once": {
        createLabel("Date and time", true);
        const current = schedule.at && new Date(schedule.at).getTime() > Date.now() ? new Date(schedule.at) : new Date(Date.now() + 60 * 60 * 1e3);
        const pad2 = (value) => String(value).padStart(2, "0");
        this.scheduleInputs.at = createInput({
          type: "datetime-local",
          value: `${current.getFullYear()}-${pad2(current.getMonth() + 1)}-${pad2(current.getDate())}T${pad2(current.getHours())}:${pad2(current.getMinutes())}`
        });
        break;
      }
      case "daily": {
        createLabel("Time (HH:MM)", true);
        this.scheduleInputs.time = createInput({ type: "time", value: schedule.time || "09:00" });
        createLabel("Repeat cadence (every N days)");
        this.scheduleInputs.everyDays = createInput({
          type: "number",
          value: String(schedule.everyDays || 1),
          min: "1",
          placeholder: "1 (daily)"
        });
        createLabel("Initial starting date (optional)");
        this.scheduleInputs.startAt = createInput({
          type: "date",
          value: schedule.startAt ? schedule.startAt.slice(0, 10) : "",
          placeholder: "YYYY-MM-DD"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "weekly": {
        createLabel("Time (HH:MM)", true);
        this.scheduleInputs.time = createInput({ type: "time", value: schedule.time || "09:00" });
        createLabel("Repeat cadence (every N weeks)");
        this.scheduleInputs.everyWeeks = createInput({
          type: "number",
          value: String(schedule.everyWeeks || 1),
          min: "1",
          placeholder: "1 (every week)"
        });
        createLabel("Days of week", true);
        const row = container.createDiv("ai-scheduler-days");
        DAY_SHORT_NAMES.forEach((day, index) => {
          const item = row.createEl("label");
          const checkbox = item.createEl("input", { type: "checkbox" });
          checkbox.checked = Array.isArray(schedule.days) ? schedule.days.includes(index) : false;
          checkbox.onchange = onChange;
          item.createSpan({ text: day });
          this.scheduleInputs.dayChecks.push(checkbox);
        });
        createLabel("Initial starting date (optional)");
        this.scheduleInputs.startAt = createInput({
          type: "date",
          value: schedule.startAt ? schedule.startAt.slice(0, 10) : "",
          placeholder: "YYYY-MM-DD"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "monthly": {
        createLabel("Time (HH:MM)", true);
        this.scheduleInputs.time = createInput({ type: "time", value: schedule.time || "09:00" });
        createLabel("Day of month (1-31)", true);
        this.scheduleInputs.dayOfMonth = createInput({
          type: "number",
          value: String(schedule.dayOfMonth || 1),
          min: "1",
          max: "31",
          placeholder: "1"
        });
        createLabel("Repeat cadence (every N months)");
        this.scheduleInputs.everyMonths = createInput({
          type: "number",
          value: String(schedule.everyMonths || 1),
          min: "1",
          placeholder: "1 (every month)"
        });
        createLabel("Initial starting date (optional)");
        this.scheduleInputs.startAt = createInput({
          type: "date",
          value: schedule.startAt ? schedule.startAt.slice(0, 10) : "",
          placeholder: "YYYY-MM-DD"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "yearly": {
        createLabel("Time (HH:MM)", true);
        this.scheduleInputs.time = createInput({ type: "time", value: schedule.time || "09:00" });
        createLabel("Month", true);
        const monthSelect = container.createEl("select");
        monthSelect.addClass("ai-scheduler-select");
        for (let m = 1; m <= 12; m++) {
          const opt = monthSelect.createEl("option", { value: String(m), text: MONTH_NAMES2[m] });
          opt.selected = m === (schedule.month || 1);
        }
        monthSelect.onchange = onChange;
        this.scheduleInputs.month = monthSelect;
        createLabel("Day of month (1-31)", true);
        this.scheduleInputs.dayOfMonth = createInput({
          type: "number",
          value: String(schedule.dayOfMonth || 1),
          min: "1",
          max: "31",
          placeholder: "1"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "hourly": {
        createLabel("Initial starting time (HH:MM, optional)");
        this.scheduleInputs.time = createInput({
          type: "time",
          value: schedule.time || "",
          placeholder: "09:00"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "interval": {
        createLabel("Interval in minutes", true);
        this.scheduleInputs.intervalMinutes = createInput({
          type: "number",
          value: String(schedule.intervalMinutes || 30),
          min: "1",
          placeholder: "30"
        });
        createLabel("Initial starting time (HH:MM, optional)");
        this.scheduleInputs.time = createInput({
          type: "time",
          value: schedule.time || "",
          placeholder: "09:00"
        });
        createLabel("Initial starting date (optional)");
        this.scheduleInputs.startAt = createInput({
          type: "date",
          value: schedule.startAt ? schedule.startAt.slice(0, 10) : "",
          placeholder: "YYYY-MM-DD"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "multi": {
        createLabel("Rules, one per line: days = HH:MM, HH:MM (e.g. Mon-Fri = 09:00)", true);
        const area = container.createEl("textarea", { text: formatMultiRules(schedule.rules) });
        area.addClass("ai-scheduler-textarea");
        area.addClass("ai-scheduler-textarea-short");
        area.oninput = onChange;
        this.scheduleInputs.multiArea = area;
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "event": {
        createLabel("Vault event", true);
        const select = container.createEl("select");
        select.addClass("ai-scheduler-select");
        select.createEl("option", { value: "modify", text: "Any file is modified or created" });
        select.onchange = onChange;
        createLabel("Cooldown minutes between runs", true);
        this.scheduleInputs.cooldownMinutes = createInput({
          type: "number",
          value: String((_a = this.job.cooldownMinutes) != null ? _a : 10),
          min: "1"
        });
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
      case "cron": {
        createLabel("5-field cron: minute, hour, day-of-month, month, day-of-week (0 = Sunday)", true);
        this.scheduleInputs.cronInput = createInput({
          type: "text",
          value: schedule.expression || "",
          placeholder: "*/15 * * * *   or   0 9 * * 1-5",
          monospace: true
        });
        container.createDiv("ai-scheduler-example").setText("Examples: */15 * * * * every 15 minutes \xB7 0 9 * * 1-5 weekdays at 09:00 \xB7 0 22 * * * daily at 22:00");
        createLabel("Stop after N runs (optional)");
        this.scheduleInputs.maxIterations = createInput({
          type: "number",
          value: schedule.maxIterations ? String(schedule.maxIterations) : "",
          min: "1",
          placeholder: "Run indefinitely"
        });
        break;
      }
    }
  }
  readEditorState() {
    var _a;
    const previous = this.job.schedule;
    const s = this.scheduleInputs;
    const maxIterations = s.maxIterations && s.maxIterations.value.trim() ? normalizeMaxIterations(s.maxIterations.value) : null;
    const startAtDate = s.startAt && s.startAt.value.trim() ? s.startAt.value.trim() : void 0;
    switch (this.kind) {
      case "once": {
        const date = s.at && s.at.value ? new Date(s.at.value) : null;
        return {
          schedule: {
            kind: "once",
            at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : previous.at
          }
        };
      }
      case "daily": {
        const time = s.time && s.time.value ? s.time.value : previous.time || "09:00";
        const everyDays = s.everyDays && Number(s.everyDays.value) > 0 ? Number(s.everyDays.value) : 1;
        return {
          schedule: {
            kind: "daily",
            time,
            everyDays,
            startAt: startAtDate,
            maxIterations
          }
        };
      }
      case "weekly": {
        const time = s.time && s.time.value ? s.time.value : previous.time || "09:00";
        const everyWeeks = s.everyWeeks && Number(s.everyWeeks.value) > 0 ? Number(s.everyWeeks.value) : 1;
        const days = s.dayChecks.map((checkbox, index) => checkbox.checked ? index : -1).filter((index) => index >= 0);
        return {
          schedule: {
            kind: "weekly",
            time,
            days,
            everyWeeks,
            startAt: startAtDate,
            maxIterations
          }
        };
      }
      case "monthly": {
        const time = s.time && s.time.value ? s.time.value : previous.time || "09:00";
        const dayOfMonth = s.dayOfMonth && Number(s.dayOfMonth.value) >= 1 && Number(s.dayOfMonth.value) <= 31 ? Number(s.dayOfMonth.value) : 1;
        const everyMonths = s.everyMonths && Number(s.everyMonths.value) > 0 ? Number(s.everyMonths.value) : 1;
        return {
          schedule: {
            kind: "monthly",
            time,
            dayOfMonth,
            everyMonths,
            startAt: startAtDate,
            maxIterations
          }
        };
      }
      case "yearly": {
        const time = s.time && s.time.value ? s.time.value : previous.time || "09:00";
        const month = s.month && Number(s.month.value) >= 1 && Number(s.month.value) <= 12 ? Number(s.month.value) : 1;
        const dayOfMonth = s.dayOfMonth && Number(s.dayOfMonth.value) >= 1 && Number(s.dayOfMonth.value) <= 31 ? Number(s.dayOfMonth.value) : 1;
        return {
          schedule: {
            kind: "yearly",
            time,
            month,
            dayOfMonth,
            maxIterations
          }
        };
      }
      case "multi": {
        const rules = s.multiArea ? parseMultiRulesText(s.multiArea.value) : previous.rules || [];
        return {
          schedule: {
            kind: "multi",
            rules,
            maxIterations
          }
        };
      }
      case "hourly": {
        const time = s.time && s.time.value ? s.time.value : void 0;
        return {
          schedule: {
            kind: "hourly",
            time,
            maxIterations
          }
        };
      }
      case "interval": {
        const minutes = s.intervalMinutes && Number(s.intervalMinutes.value) > 0 ? Number(s.intervalMinutes.value) : Number(previous.intervalMinutes || 30);
        const time = s.time && s.time.value ? s.time.value : void 0;
        return {
          schedule: {
            kind: "interval",
            intervalMinutes: minutes,
            time,
            startAt: startAtDate,
            maxIterations
          }
        };
      }
      case "event": {
        const cooldown = s.cooldownMinutes && Number(s.cooldownMinutes.value) > 0 ? Number(s.cooldownMinutes.value) : (_a = this.job.cooldownMinutes) != null ? _a : 10;
        return {
          schedule: {
            kind: "event",
            event: "modify",
            maxIterations
          },
          cooldownMinutes: cooldown
        };
      }
      case "cron": {
        return {
          schedule: {
            kind: "cron",
            expression: s.cronInput ? s.cronInput.value.trim() : previous.expression || "",
            maxIterations
          }
        };
      }
    }
  }
  validateState(state) {
    const schedule = state.schedule;
    if (schedule.kind === "event") return null;
    if (schedule.kind === "cron") {
      if (!schedule.expression) return "Enter a cron expression, for example */15 * * * *";
      return validateCron(schedule.expression);
    }
    if (schedule.kind === "once") {
      const time = schedule.at ? new Date(schedule.at).getTime() : NaN;
      if (Number.isNaN(time)) return "Pick a valid date and time.";
      if (time <= Date.now()) return "Pick a future date and time.";
      return null;
    }
    if (schedule.kind === "daily" && !validClock(schedule.time)) return "Enter a time as HH:MM.";
    if (schedule.kind === "weekly" && (!validClock(schedule.time) || !(schedule.days || []).length)) return "Choose at least one weekday and a valid time.";
    if (schedule.kind === "monthly" && (!validClock(schedule.time) || !schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) return "Enter a valid day of month (1-31) and time.";
    if (schedule.kind === "yearly" && (!validClock(schedule.time) || !schedule.month || !schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) return "Enter a valid month, day of month, and time.";
    if (schedule.kind === "multi" && !(schedule.rules || []).length) return "Add at least one valid rule, e.g. Mon = 09:00.";
    if (schedule.kind === "hourly" || schedule.kind === "interval") {
      const minutes = schedule.kind === "hourly" ? 60 : Number(schedule.intervalMinutes || 0);
      if (!(minutes > 0)) return "Enter an interval greater than zero.";
    }
    if (!getScheduleNextRun(schedule, new Date(Date.now() - 1e3))) {
      return "The schedule has no valid upcoming time. Check the values.";
    }
    return null;
  }
  onClose() {
    this.contentEl.empty();
    this.scheduleInputs = { dayChecks: [] };
    this.kindSelect = null;
  }
};

// src/ui/PlannerModal.ts
var import_obsidian5 = require("obsidian");
function appendTaskIdBadge(container, id2) {
  const idBadge = container.createSpan({ cls: "ai-scheduler-task-id-badge", text: `ID: ${id2}` });
  idBadge.setAttribute("title", "Click to copy task ID");
  idBadge.onclick = (e) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(id2).then(() => {
        new import_obsidian5.Notice(`Copied Task ID: ${id2}`);
      });
    }
  };
}
var PlannerModal = class _PlannerModal extends import_obsidian5.Modal {
  constructor(app, plugin, plannedJobs = null) {
    super(app);
    this.plannedJobs = null;
    this.plugin = plugin;
    this.plannedJobs = plannedJobs;
  }
  async onOpen() {
    closeExistingSchedulerModals(this);
    if (this.plannedJobs && this.plannedJobs.length) this.renderResults();
    else await this.renderForm();
  }
  async renderForm() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-md");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: "ai-scheduler-shell ai-scheduler-shell-md" });
    const navBar = shell.createDiv({ cls: "ai-scheduler-modal-nav" });
    const backBtn = navBar.createEl("button", {
      cls: "ai-scheduler-back-btn",
      text: "\u2190 back to dashboard"
    });
    backBtn.onclick = () => {
      this.close();
      window.setTimeout(() => {
        new AssistantModal(this.app, this.plugin).open();
      }, 50);
    };
    shell.createDiv({ cls: "ai-scheduler-eyebrow", text: "AI Planner" });
    shell.createEl("h1", { text: "Plan scheduled work", cls: "ai-scheduler-title ai-scheduler-title-sm" });
    shell.createEl("p", { text: "Describe your goal in plain english. Your active AI backend will design and configure the scheduled jobs.", cls: "ai-scheduler-subtitle" });
    const readiness = this.plugin.getBackendReadiness();
    if (!readiness.ok) {
      const banner = shell.createDiv({ cls: "ai-scheduler-alert-banner" });
      const content = banner.createDiv({ cls: "ai-scheduler-alert-content" });
      content.createSpan({ cls: "ai-scheduler-alert-icon", text: "\u26A0\uFE0F" });
      const textCol = content.createDiv();
      textCol.createDiv({ cls: "ai-scheduler-alert-title", text: "AI backend not configured" });
      textCol.createDiv({ cls: "ai-scheduler-alert-desc", text: readiness.message });
      const btn = banner.createEl("button", { text: "Open settings", cls: "mod-cta ai-scheduler-alert-btn" });
      btn.onclick = () => {
        this.close();
        window.setTimeout(() => {
          this.plugin.openSettingsTab();
        }, 50);
      };
    }
    shell.createDiv({ cls: "ai-scheduler-form-label", text: "What would you like AI Scheduler to do?" });
    const textarea = shell.createEl("textarea", { cls: "ai-scheduler-textarea ai-scheduler-textarea-tall" });
    textarea.placeholder = "E.g. Every weekday at 9:00 am, review notes modified in the last 24 hours, extract action items, and create an executive summary in AI reviews (type @ to attach files)...";
    shell.createDiv({ cls: "ai-scheduler-hint ai-scheduler-hint-gap", text: "Tip: Type @ in the box above to quickly search and attach vault notes/files." });
    shell.createDiv({ cls: "ai-scheduler-form-label", text: "Default result folder (optional)" });
    const resultFolder = shell.createEl("input", { type: "text", cls: "ai-scheduler-input ai-scheduler-form-gap", placeholder: "Optional result folder, e.g. AI Reviews or Projects/Notes" });
    const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);
    attachMentionSuggest({
      textarea,
      app: this.app,
      onSelect: (file) => {
        contextPicker.addPath(file.path);
        new import_obsidian5.Notice(`Attached to context: ${file.path}`);
      }
    });
    const footer = shell.createDiv({ cls: "ai-scheduler-footer" });
    makeButton(footer, "Cancel", () => this.close());
    makeButton(footer, "Create AI plan", async (button) => {
      const goal = textarea.value.trim();
      if (!goal) {
        new import_obsidian5.Notice("Describe what you want AI Scheduler to do.");
        return;
      }
      button.disabled = true;
      button.setText("AI is planning...");
      textarea.disabled = true;
      resultFolder.disabled = true;
      const loader = shell.createDiv({ cls: "ai-scheduler-planning-card" });
      loader.createDiv({ cls: "ai-scheduler-spinner" });
      loader.createDiv({ cls: "ai-scheduler-planning-title", text: "AI is designing your schedule..." });
      loader.createDiv({ cls: "ai-scheduler-planning-subtitle", text: "Analyzing your goal, determining timing cadences, and generating scheduled task definitions." });
      loader.scrollIntoView({ behavior: "smooth" });
      try {
        const result = await this.plugin.planAndCreate(goal, contextPicker.getPaths(), resultFolder.value.trim());
        new import_obsidian5.Notice(`AI created ${result.jobs.length} task(s)`, 6e3);
        this.plannedJobs = result.jobs;
        this.renderResults();
      } catch (error) {
        loader.remove();
        textarea.disabled = false;
        resultFolder.disabled = false;
        button.disabled = false;
        button.setText("Create AI plan");
        new import_obsidian5.Notice(`Planning failed: ${errorText(error)}`, 8e3);
      }
    }, true);
  }
  /* After planning, show the created schedules in editable cards where the user
   * can edit, delete, or discard tasks before proceeding. */
  renderResults() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-lg");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: "ai-scheduler-shell ai-scheduler-shell-lg" });
    const navBar = shell.createDiv({ cls: "ai-scheduler-modal-nav" });
    const backBtn = navBar.createEl("button", {
      cls: "ai-scheduler-back-btn",
      text: "\u2190 back to dashboard"
    });
    backBtn.onclick = () => {
      this.close();
      window.setTimeout(() => {
        new AssistantModal(this.app, this.plugin).open();
      }, 50);
    };
    shell.createEl("h1", { text: "Planned schedule review", cls: "ai-scheduler-title ai-scheduler-title-sm" });
    shell.createEl("p", {
      text: "AI created the following task(s). You can edit any schedule manually, adjust prompts, or discard tasks before proceeding.",
      cls: "ai-scheduler-subtitle"
    });
    const currentJobs = (this.plannedJobs || []).map((j) => this.plugin.jobs.find((existing) => existing.id === j.id) || j);
    if (!currentJobs.length) {
      const empty = makeCard(shell, "ai-scheduler-card-muted");
      empty.createDiv({ text: "All planned tasks were discarded." });
      const footer2 = shell.createDiv({ cls: "ai-scheduler-footer" });
      makeButton(footer2, "Plan new schedule", () => {
        this.plannedJobs = null;
        void this.renderForm();
      }, true);
      return;
    }
    for (const job of currentJobs) {
      const card = shell.createDiv({ cls: "ai-scheduler-planned-card" });
      const top = card.createDiv({ cls: "ai-scheduler-planned-header" });
      const titleRow = top.createDiv({ cls: "ai-scheduler-task-header" });
      titleRow.createDiv({ cls: "ai-scheduler-task-title", text: `#${job.taskNumber} \xB7 ${job.title}` });
      appendTaskIdBadge(titleRow, job.id);
      if (job.doubt) {
        titleRow.createSpan({ cls: "ai-scheduler-doubt-badge", text: "Unspecified details *" });
      }
      const actions = top.createDiv({ cls: "ai-scheduler-planned-actions" });
      makeButton(actions, "Edit", () => {
        this.close();
        window.setTimeout(() => {
          new JobModal(this.app, this.plugin, job, () => {
            new _PlannerModal(this.app, this.plugin, this.plannedJobs).open();
          }).open();
        }, 50);
      });
      makeButton(actions, "Discard", async () => {
        await this.plugin.deleteJob(job);
        this.plannedJobs = (this.plannedJobs || []).filter((j) => j.id !== job.id);
        new import_obsidian5.Notice(`Discarded: ${job.title}`);
        this.renderResults();
      }, false, true);
      const cronForm = cronFormFor(job.schedule);
      const runs = previewSchedule(job.schedule, 3);
      const meta = card.createDiv({ cls: "ai-scheduler-task-meta" });
      meta.setText(`Schedule: ${describeSchedule(job)}${cronForm ? ` (${cronForm})` : ""} \xB7 Next: ${runs.length ? runs[0] : job.nextRunAt ? formatDate(job.nextRunAt) : "on trigger"}`);
      if (job.doubt) {
        const doubtBanner = card.createDiv({ cls: "ai-scheduler-alert-banner ai-scheduler-gap-8" });
        const content = doubtBanner.createDiv({ cls: "ai-scheduler-alert-content" });
        content.createSpan({ cls: "ai-scheduler-alert-icon", text: "\u{1F4A1}" });
        const textCol = content.createDiv();
        textCol.createDiv({ cls: "ai-scheduler-alert-title", text: "AI Planning Note & Unspecified Fields" });
        textCol.createDiv({ cls: "ai-scheduler-alert-desc", text: `${job.doubt} Default values were populated. Click 'Edit' if you wish to adjust any parameters.` });
      }
      if (job.prompt) {
        const promptBox = card.createDiv({ cls: "ai-scheduler-task-prompt" });
        promptBox.setText(job.prompt);
      }
      if (job.contextPaths && job.contextPaths.length) {
        const ctxRow = card.createDiv({ cls: "ai-scheduler-context-chips" });
        job.contextPaths.forEach((p) => {
          const chip = ctxRow.createDiv({ cls: "ai-scheduler-context-chip" });
          chip.createSpan({ cls: "ai-scheduler-chip-icon", text: p.endsWith("/") ? "\u{1F4C1}" : "\u{1F4C4}" });
          chip.createSpan({ cls: "ai-scheduler-chip-text", text: p });
        });
      }
    }
    const summary = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-gap");
    summary.createDiv({ cls: "ai-scheduler-hint", text: 'Tip: You can edit or refine any task with "Edit", or edit later from the dashboard.' });
    const footer = shell.createDiv({ cls: "ai-scheduler-footer" });
    makeButton(footer, "Discard all", async () => {
      for (const job of currentJobs) {
        await this.plugin.deleteJob(job);
      }
      this.plannedJobs = null;
      new import_obsidian5.Notice("All planned tasks discarded.");
      await this.renderForm();
    }, false, true);
    makeButton(footer, "Done & open AI Scheduler", () => {
      this.close();
      window.setTimeout(() => {
        new AssistantModal(this.app, this.plugin).open();
      }, 50);
    }, true);
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/ui/TaskViewModal.ts
var import_obsidian6 = require("obsidian");
var TaskViewModal = class extends import_obsidian6.Modal {
  constructor(app, plugin, job, onBack) {
    super(app);
    this.plugin = plugin;
    this.job = job;
    this.onBack = onBack;
  }
  onOpen() {
    closeExistingSchedulerModals(this);
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-lg");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    this.render();
  }
  getRelatedFiles() {
    const files = [];
    const seen = /* @__PURE__ */ new Set();
    const addFile = (rawPath, type, label) => {
      const norm = (0, import_obsidian6.normalizePath)(rawPath.trim().replace(/^\[\[|\]\]$/g, ""));
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      const abstractFile = this.app.vault.getAbstractFileByPath(norm);
      let exists = false;
      let sizeBytes;
      let mtime;
      if (abstractFile instanceof import_obsidian6.TFile) {
        exists = true;
        sizeBytes = abstractFile.stat.size;
        mtime = abstractFile.stat.mtime;
      } else if (abstractFile instanceof import_obsidian6.TFolder) {
        exists = true;
      } else {
        const mdFile = this.app.vault.getAbstractFileByPath(`${norm}.md`);
        if (mdFile instanceof import_obsidian6.TFile) {
          exists = true;
          sizeBytes = mdFile.stat.size;
          mtime = mdFile.stat.mtime;
        }
      }
      files.push({
        path: norm,
        type,
        label,
        exists,
        sizeBytes,
        mtime
      });
    };
    if (this.job.lastOutputPath) {
      addFile(this.job.lastOutputPath, "output", "Created output file");
    }
    if (Array.isArray(this.job.lastOutputFiles)) {
      this.job.lastOutputFiles.forEach((p) => addFile(p, "output", "Output file"));
    }
    if (this.job.output && this.job.output.folder) {
      const folder = this.job.output.folder;
      const filename = this.job.output.filename;
      if (filename) {
        addFile(`${folder}/${filename}`, "output", "Target output file");
      }
    }
    if (this.job.notePath) {
      addFile(this.job.notePath, "schedule-note", "Schedule note");
    }
    if (Array.isArray(this.job.contextPaths)) {
      this.job.contextPaths.forEach((p) => addFile(p, "context", "Attached context note"));
    }
    if (this.job.lastReply) {
      const wikiLinkRegex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
      let match;
      while ((match = wikiLinkRegex.exec(this.job.lastReply)) !== null) {
        const linkTarget = match[1].trim();
        if (linkTarget) {
          addFile(linkTarget, "modified", "Referenced in output");
        }
      }
    }
    return files;
  }
  openFile(path) {
    const norm = (0, import_obsidian6.normalizePath)(path);
    let targetFile = this.app.vault.getAbstractFileByPath(norm);
    if (!targetFile && !norm.endsWith(".md")) {
      targetFile = this.app.vault.getAbstractFileByPath(`${norm}.md`);
    }
    if (targetFile instanceof import_obsidian6.TFile) {
      void this.app.workspace.getLeaf(false).openFile(targetFile);
      new import_obsidian6.Notice(`Opened: ${targetFile.basename}`);
      this.close();
    } else {
      void this.app.workspace.openLinkText(norm, "", false);
      new import_obsidian6.Notice(`Navigating to: ${norm}`);
      this.close();
    }
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    const shell = contentEl.createDiv({ cls: "ai-scheduler-shell ai-scheduler-shell-lg" });
    const navBar = shell.createDiv({ cls: "ai-scheduler-modal-nav" });
    const backBtn = navBar.createEl("button", {
      cls: "ai-scheduler-back-btn",
      text: "\u2190 back to dashboard"
    });
    backBtn.onclick = () => {
      this.close();
      if (this.onBack) {
        window.setTimeout(() => this.onBack(), 50);
      } else {
        window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
      }
    };
    const headerRow = shell.createDiv({ cls: "ai-scheduler-task-header ai-scheduler-gap-8" });
    headerRow.createEl("h1", { text: `Task #${this.job.taskNumber} \xB7 ${this.job.title}`, cls: "ai-scheduler-title ai-scheduler-title-sm" });
    const idBadge = headerRow.createSpan({ cls: "ai-scheduler-task-id-badge", text: `ID: ${this.job.id}` });
    idBadge.setAttribute("title", "Click to copy task ID");
    idBadge.onclick = (e) => {
      e.stopPropagation();
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(this.job.id).then(() => {
          new import_obsidian6.Notice(`Copied Task ID: ${this.job.id}`);
        });
      }
    };
    const metaCard = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
    const metaGrid = metaCard.createDiv({ cls: "ai-scheduler-view-grid" });
    const statusCol = metaGrid.createDiv();
    statusCol.createDiv({ cls: "ai-scheduler-stat-label", text: "STATUS" });
    const statusBadge = statusCol.createDiv({ cls: "ai-scheduler-task-title" });
    const statusText = this.job.lastStatus || this.job.status || "completed";
    statusBadge.setText(statusText.toUpperCase());
    const timingCol = metaGrid.createDiv();
    timingCol.createDiv({ cls: "ai-scheduler-stat-label", text: "LAST EXECUTED" });
    timingCol.createDiv({ cls: "ai-scheduler-view-val", text: this.job.lastRunAt ? formatDate(this.job.lastRunAt) : "Never" });
    const scheduleCol = metaGrid.createDiv();
    scheduleCol.createDiv({ cls: "ai-scheduler-stat-label", text: "SCHEDULE" });
    scheduleCol.createDiv({ cls: "ai-scheduler-view-val", text: describeSchedule(this.job) });
    const backendCol = metaGrid.createDiv();
    backendCol.createDiv({ cls: "ai-scheduler-stat-label", text: "AI BACKEND / MODEL" });
    backendCol.createDiv({ cls: "ai-scheduler-view-val", text: describeBinding(this.job) });
    if (this.job.lastError) {
      const errBanner = shell.createDiv({ cls: "ai-scheduler-alert-banner" });
      const errContent = errBanner.createDiv({ cls: "ai-scheduler-alert-content" });
      errContent.createSpan({ cls: "ai-scheduler-alert-icon", text: "\u26A0\uFE0F" });
      const errText = errContent.createDiv();
      errText.createDiv({ cls: "ai-scheduler-alert-title", text: "Task execution failed" });
      errText.createDiv({ cls: "ai-scheduler-alert-desc", text: this.job.lastError });
    }
    const relatedFiles = this.getRelatedFiles();
    const filesHeading = shell.createDiv("ai-scheduler-section-heading");
    filesHeading.createEl("h2", { text: "Created & modified files", cls: "ai-scheduler-section-title" });
    filesHeading.createSpan({ text: `${relatedFiles.length} file(s) associated with this task`, cls: "ai-scheduler-section-desc" });
    const filesContainer = shell.createDiv({ cls: "ai-scheduler-files-list" });
    if (!relatedFiles.length) {
      const empty = makeCard(filesContainer, "ai-scheduler-card-muted");
      empty.createDiv({ text: "No specific files recorded for this task." });
      empty.createDiv({ cls: "ai-scheduler-empty-sub", text: "The AI output response is preserved below." });
    } else {
      for (const fileRef of relatedFiles) {
        const fileCard = filesContainer.createDiv({ cls: "ai-scheduler-file-row" });
        fileCard.onclick = () => this.openFile(fileRef.path);
        const left = fileCard.createDiv({ cls: "ai-scheduler-file-left" });
        left.createSpan({ cls: "ai-scheduler-file-icon", text: fileRef.path.endsWith("/") ? "\u{1F4C1}" : "\u{1F4C4}" });
        const details = left.createDiv({ cls: "ai-scheduler-file-details" });
        const titleLine = details.createDiv({ cls: "ai-scheduler-file-path", text: fileRef.path });
        if (fileRef.exists) {
          titleLine.addClass("is-existing");
        }
        const subLine = details.createDiv({ cls: "ai-scheduler-file-meta" });
        subLine.createSpan({ cls: `ai-scheduler-file-badge ai-scheduler-file-badge-${fileRef.type}`, text: fileRef.label });
        if (fileRef.sizeBytes !== void 0) {
          const sizeKb = Math.round(fileRef.sizeBytes / 1024);
          subLine.createSpan({ text: ` \xB7 ${sizeKb} KB` });
        }
        if (fileRef.mtime) {
          subLine.createSpan({ text: ` \xB7 Modified ${formatDate(new Date(fileRef.mtime).toISOString())}` });
        }
        if (!fileRef.exists) {
          subLine.createSpan({ cls: "ai-scheduler-file-missing", text: " \xB7 (File not in vault)" });
        }
        const right = fileCard.createDiv({ cls: "ai-scheduler-file-right" });
        const openBtn = right.createEl("button", {
          cls: "ai-scheduler-open-file-btn",
          text: "Open file \u2197"
        });
        openBtn.onclick = (e) => {
          e.stopPropagation();
          this.openFile(fileRef.path);
        };
      }
    }
    if (this.job.prompt) {
      const promptHeading = shell.createDiv("ai-scheduler-section-heading");
      promptHeading.createEl("h2", { text: "Prompt & instructions", cls: "ai-scheduler-section-title" });
      const promptCard = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
      promptCard.createDiv({ cls: "ai-scheduler-prompt-preview", text: this.job.prompt });
    }
    if (this.job.lastReply) {
      const outputHeading = shell.createDiv("ai-scheduler-section-heading");
      outputHeading.createEl("h2", { text: "Latest AI output response", cls: "ai-scheduler-section-title" });
      makeButton(outputHeading, "Copy output", () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(this.job.lastReply).then(() => {
            new import_obsidian6.Notice("Copied AI output to clipboard.");
          });
        }
      });
      const replyCard = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
      const replyBox = replyCard.createDiv({ cls: "ai-scheduler-reply-preview" });
      replyBox.setText(this.job.lastReply);
    }
    const footer = shell.createDiv({ cls: "ai-scheduler-footer" });
    makeButton(footer, "Close", () => this.close());
    const isDeleted = this.plugin.deletedJobs.some((j) => j.id === this.job.id);
    if (isDeleted) {
      makeButton(footer, "Restore task", () => {
        void (async () => {
          await this.plugin.restoreJob(this.job);
          new import_obsidian6.Notice(`Restored task #${this.job.taskNumber}: ${this.job.title}`);
          this.close();
          if (this.onBack) this.onBack();
        })();
      });
      makeButton(footer, "Delete forever", () => {
        new ConfirmModal(
          this.app,
          `Permanently delete task #${this.job.taskNumber} (${this.job.title})? This cannot be undone.`,
          () => {
            void (async () => {
              await this.plugin.permanentlyDeleteJob(this.job);
              new import_obsidian6.Notice(`Permanently deleted task #${this.job.taskNumber}.`);
              this.close();
              if (this.onBack) this.onBack();
            })();
          }
        ).open();
      }, false, true);
    } else {
      makeButton(footer, "Run again", () => {
        new ConfirmModal(
          this.app,
          `Run task #${this.job.taskNumber} (${this.job.title}) immediately? It will execute in the background now.`,
          () => {
            void (async () => {
              new import_obsidian6.Notice(`Starting task #${this.job.taskNumber} now...`);
              await this.plugin.retryJob(this.job);
              this.close();
              if (this.onBack) this.onBack();
            })();
          }
        ).open();
      });
      makeButton(footer, "Delete task", () => {
        new ConfirmModal(
          this.app,
          `Delete task #${this.job.taskNumber}? It will be moved to Deleted tasks and can be restored.`,
          () => {
            void (async () => {
              await this.plugin.deleteJob(this.job);
              new import_obsidian6.Notice(`Deleted task #${this.job.taskNumber}. You can restore it from Deleted tasks.`);
              this.close();
              if (this.onBack) this.onBack();
            })();
          }
        ).open();
      }, false, true);
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/ui/CalendarModal.ts
var import_obsidian7 = require("obsidian");
function toLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatClockTime(d) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m} ${ampm}`;
}
var CalendarModal = class _CalendarModal extends import_obsidian7.Modal {
  constructor(app, plugin, initialDate = /* @__PURE__ */ new Date()) {
    super(app);
    this.activeFilter = "all";
    this.viewMode = "month";
    this.refreshTimer = null;
    this.plugin = plugin;
    this.currentYear = initialDate.getFullYear();
    this.currentMonth = initialDate.getMonth();
    this.selectedDate = new Date(initialDate);
  }
  onOpen() {
    closeExistingSchedulerModals(this);
    this.render();
    this.refreshTimer = window.setInterval(() => {
      this.render();
    }, 4e3);
  }
  onClose() {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contentEl.empty();
  }
  getRelevantJobs() {
    let jobs = this.plugin.jobs;
    if (this.activeFilter === "active") {
      jobs = jobs.filter((j) => j.enabled && j.status !== "disabled");
    } else if (this.activeFilter === "paused") {
      jobs = jobs.filter((j) => !j.enabled || j.status === "disabled");
    }
    return jobs;
  }
  buildOccurrencesMap(start, end) {
    const map = /* @__PURE__ */ new Map();
    const now = /* @__PURE__ */ new Date();
    const jobs = this.getRelevantJobs();
    for (const job of jobs) {
      const dates = getScheduleOccurrencesInRange(job.schedule, start, end, 150);
      for (const d of dates) {
        const key = toLocalDateKey(d);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
          job,
          date: d,
          timeStr: formatClockTime(d),
          isPast: d < now,
          isReview: isNightlyReviewJob(job)
        });
      }
    }
    for (const [, list] of map.entries()) {
      list.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return map;
  }
  render() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-lg");
    this.modalEl.addClass("ai-scheduler-calendar-modal");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv("ai-scheduler-shell ai-scheduler-shell-lg");
    const header = shell.createDiv({ cls: "ai-scheduler-calendar-header" });
    const titleCol = header.createDiv();
    titleCol.createEl("h1", { text: "Schedule calendar", cls: "ai-scheduler-title" });
    titleCol.createEl("p", {
      text: "Visualize and manage scheduled AI tasks across days, weeks, and months.",
      cls: "ai-scheduler-subtitle"
    });
    const topActions = header.createDiv({ cls: "ai-scheduler-calendar-top-actions" });
    makeButton(topActions, "\u{1F4CB} Task dashboard", () => {
      this.close();
      window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
    });
    makeButton(topActions, "\u26A1 Ask AI to plan", () => {
      this.close();
      window.setTimeout(() => new PlannerModal(this.app, this.plugin).open(), 50);
    });
    makeButton(topActions, "+ New task", () => {
      this.close();
      window.setTimeout(() => {
        new JobModal(this.app, this.plugin, normalizeJob({ prompt: "", title: "" }), () => {
          new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
        }).open();
      }, 50);
    }, true);
    const controlsBar = shell.createDiv({ cls: "ai-scheduler-cal-controls" });
    const navGroup = controlsBar.createDiv({ cls: "ai-scheduler-cal-nav" });
    const prevBtn = navGroup.createEl("button", { text: "\u2039", cls: "ai-scheduler-cal-nav-btn" });
    prevBtn.setAttribute("title", "Previous month");
    prevBtn.onclick = () => {
      if (this.currentMonth === 0) {
        this.currentMonth = 11;
        this.currentYear -= 1;
      } else {
        this.currentMonth -= 1;
      }
      this.render();
    };
    navGroup.createDiv({
      cls: "ai-scheduler-cal-month-title",
      text: `${MONTH_NAMES2[this.currentMonth + 1]} ${this.currentYear}`
    });
    const nextBtn = navGroup.createEl("button", { text: "\u203A", cls: "ai-scheduler-cal-nav-btn" });
    nextBtn.setAttribute("title", "Next month");
    nextBtn.onclick = () => {
      if (this.currentMonth === 11) {
        this.currentMonth = 0;
        this.currentYear += 1;
      } else {
        this.currentMonth += 1;
      }
      this.render();
    };
    const todayBtn = navGroup.createEl("button", { text: "Today", cls: "ai-scheduler-cal-today-btn" });
    todayBtn.onclick = () => {
      const today = /* @__PURE__ */ new Date();
      this.currentYear = today.getFullYear();
      this.currentMonth = today.getMonth();
      this.selectedDate = today;
      this.render();
    };
    const filterGroup = controlsBar.createDiv({ cls: "ai-scheduler-cal-filter-group" });
    const filterSelect = filterGroup.createEl("select", { cls: "dropdown ai-scheduler-cal-select" });
    filterSelect.createEl("option", { text: "All tasks", value: "all" });
    filterSelect.createEl("option", { text: "Active tasks only", value: "active" });
    filterSelect.createEl("option", { text: "Paused / disabled", value: "paused" });
    filterSelect.value = this.activeFilter;
    filterSelect.onchange = () => {
      this.activeFilter = filterSelect.value;
      this.render();
    };
    const viewToggle = filterGroup.createDiv({ cls: "ai-scheduler-cal-view-toggle" });
    const monthModeBtn = viewToggle.createEl("button", {
      text: "\u{1F4C5} Month",
      cls: `ai-scheduler-cal-toggle-btn ${this.viewMode === "month" ? "is-active" : ""}`
    });
    monthModeBtn.onclick = () => {
      this.viewMode = "month";
      this.render();
    };
    const agendaModeBtn = viewToggle.createEl("button", {
      text: "\u{1F4C6} Timeline",
      cls: `ai-scheduler-cal-toggle-btn ${this.viewMode === "agenda" ? "is-active" : ""}`
    });
    agendaModeBtn.onclick = () => {
      this.viewMode = "agenda";
      this.render();
    };
    const firstOfMonth = new Date(this.currentYear, this.currentMonth, 1);
    const lastOfMonth = new Date(this.currentYear, this.currentMonth + 1, 0, 23, 59, 59, 999);
    const startDayOfWeek = firstOfMonth.getDay();
    const daysInMonth = lastOfMonth.getDate();
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - startDayOfWeek);
    gridStart.setHours(0, 0, 0, 0);
    const gridEnd = new Date(lastOfMonth);
    const trailingDays = (7 - (startDayOfWeek + daysInMonth) % 7) % 7;
    gridEnd.setDate(gridEnd.getDate() + trailingDays);
    gridEnd.setHours(23, 59, 59, 999);
    const occurrencesMap = this.buildOccurrencesMap(gridStart, gridEnd);
    if (this.viewMode === "month") {
      this.renderMonthGrid(shell, gridStart, gridEnd, occurrencesMap);
      this.renderDayDetails(shell, this.selectedDate, occurrencesMap);
    } else {
      this.renderAgendaView(shell, firstOfMonth, lastOfMonth, occurrencesMap);
    }
    this.renderEventTasksSection(shell);
  }
  renderMonthGrid(container, gridStart, gridEnd, occurrencesMap) {
    var _a;
    const calCard = makeCard(container, "ai-scheduler-cal-card");
    const grid = calCard.createDiv({ cls: "ai-scheduler-cal-grid" });
    const headerRow = grid.createDiv({ cls: "ai-scheduler-cal-weekdays" });
    for (const name of DAY_SHORT_NAMES) {
      headerRow.createDiv({ cls: "ai-scheduler-cal-weekday-cell", text: name });
    }
    const daysGrid = grid.createDiv({ cls: "ai-scheduler-cal-days" });
    const todayKey = toLocalDateKey(/* @__PURE__ */ new Date());
    const selectedKey = toLocalDateKey(this.selectedDate);
    const cur = new Date(gridStart);
    while (cur <= gridEnd) {
      const dateKey = toLocalDateKey(cur);
      const cellDate = new Date(cur);
      const isCurrentMonth = cur.getMonth() === this.currentMonth;
      const isToday = dateKey === todayKey;
      const isSelected = dateKey === selectedKey;
      const occurrences = occurrencesMap.get(dateKey) || [];
      const cell = daysGrid.createDiv({
        cls: `ai-scheduler-cal-day-cell ${isCurrentMonth ? "" : "is-outside"} ${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""}`
      });
      const cellTop = cell.createDiv({ cls: "ai-scheduler-cal-cell-top" });
      cellTop.createSpan({ cls: "ai-scheduler-cal-day-num", text: String(cellDate.getDate()) });
      if (occurrences.length > 0) {
        const countBadge = cellTop.createSpan({
          cls: "ai-scheduler-cal-count-badge",
          text: String(occurrences.length)
        });
        countBadge.setAttribute("title", `${occurrences.length} task(s) on this day`);
      }
      const chipsContainer = cell.createDiv({ cls: "ai-scheduler-cal-chips" });
      const visibleOccurrences = occurrences.slice(0, 3);
      for (const occ of visibleOccurrences) {
        const isRunning = occ.job.status === "running" || this.plugin.runningJobs.has(occ.job.id);
        const chip = chipsContainer.createDiv({
          cls: `ai-scheduler-cal-chip ${occ.isReview ? "is-review" : ""} ${isRunning ? "is-running" : ""} ${!occ.job.enabled ? "is-paused" : ""}`
        });
        chip.createSpan({ cls: "ai-scheduler-cal-chip-time", text: occ.timeStr });
        const titleText = occ.isReview ? "Nightly Review" : `#${(_a = occ.job.taskNumber) != null ? _a : ""} ${occ.job.title}`;
        chip.createSpan({ cls: "ai-scheduler-cal-chip-title", text: titleText });
        chip.setAttribute("title", `${occ.timeStr} \u2014 ${titleText} (${describeSchedule(occ.job)})`);
      }
      if (occurrences.length > 3) {
        const moreEl = chipsContainer.createDiv({
          cls: "ai-scheduler-cal-chip-more",
          text: `+${occurrences.length - 3} more`
        });
        moreEl.setAttribute("title", `${occurrences.length - 3} additional task(s)`);
      }
      cell.onclick = () => {
        this.selectedDate = cellDate;
        this.render();
      };
      cur.setDate(cur.getDate() + 1);
    }
  }
  renderDayDetails(container, date, occurrencesMap) {
    var _a, _b;
    const key = toLocalDateKey(date);
    const occurrences = occurrencesMap.get(key) || [];
    const dateFormatted = formatDate(date.toISOString()).split(" at ")[0] || `${MONTH_NAMES2[date.getMonth() + 1]} ${date.getDate()}, ${date.getFullYear()}`;
    const panel = makeCard(container, "ai-scheduler-cal-day-panel");
    const panelHead = panel.createDiv({ cls: "ai-scheduler-cal-panel-header" });
    const titleBlock = panelHead.createDiv();
    titleBlock.createEl("h3", { text: `Tasks for ${dateFormatted}`, cls: "ai-scheduler-cal-panel-title" });
    titleBlock.createDiv({
      cls: "ai-scheduler-cal-panel-subtitle",
      text: occurrences.length === 0 ? "No scheduled tasks for this date." : `${occurrences.length} task run${occurrences.length === 1 ? "" : "s"} scheduled`
    });
    const headActions = panelHead.createDiv({ cls: "ai-scheduler-cal-panel-actions" });
    makeButton(headActions, "+ Schedule Task", () => {
      this.close();
      window.setTimeout(() => {
        const defaultJob = normalizeJob({
          prompt: "",
          title: "",
          schedule: {
            kind: "once",
            at: new Date(this.selectedDate.getFullYear(), this.selectedDate.getMonth(), this.selectedDate.getDate(), 9, 0).toISOString()
          }
        });
        new JobModal(this.app, this.plugin, defaultJob, () => {
          new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
        }).open();
      }, 50);
    });
    if (occurrences.length === 0) {
      const empty = panel.createDiv({ cls: "ai-scheduler-empty" });
      empty.createDiv({ cls: "ai-scheduler-empty-title", text: "No tasks scheduled on this day" });
      empty.createDiv({
        cls: "ai-scheduler-empty-desc",
        text: "You can create a new recurring or one-time AI task to run on this day."
      });
      return;
    }
    const list = panel.createDiv({ cls: "ai-scheduler-cal-timeline-list" });
    for (const occ of occurrences) {
      const job = occ.job;
      const isRunning = job.status === "running" || this.plugin.runningJobs.has(job.id);
      const card = list.createDiv({
        cls: `ai-scheduler-cal-timeline-item ${isRunning ? "is-running" : ""} ${!job.enabled ? "is-paused" : ""}`
      });
      const timePillar = card.createDiv({ cls: "ai-scheduler-cal-timeline-time" });
      timePillar.createSpan({ cls: "ai-scheduler-cal-time-badge", text: occ.timeStr });
      const body = card.createDiv({ cls: "ai-scheduler-cal-timeline-body" });
      const row = body.createDiv({ cls: "ai-scheduler-cal-timeline-top" });
      const title = occ.isReview ? "Nightly Review" : `#${(_a = job.taskNumber) != null ? _a : "?"} ${job.title}`;
      row.createEl("h4", { text: title, cls: "ai-scheduler-cal-item-title" });
      const metaRow = body.createDiv({ cls: "ai-scheduler-cal-timeline-meta" });
      metaRow.createSpan({ cls: "ai-scheduler-badge", text: describeSchedule(job) });
      metaRow.createSpan({ cls: "ai-scheduler-badge ai-scheduler-badge-backend", text: describeBinding(job) });
      if ((_b = job.output) == null ? void 0 : _b.folder) {
        metaRow.createSpan({ cls: "ai-scheduler-badge ai-scheduler-badge-folder", text: `\u{1F4C1} ${job.output.folder}` });
      }
      if (job.prompt && !occ.isReview) {
        const promptPreview = job.prompt.length > 140 ? `${job.prompt.slice(0, 140)}...` : job.prompt;
        body.createDiv({ cls: "ai-scheduler-cal-prompt-preview", text: `\u201C${promptPreview}\u201D` });
      }
      const actions = card.createDiv({ cls: "ai-scheduler-cal-timeline-actions" });
      makeButton(actions, "\u25B6 Run now", () => {
        void (async () => {
          var _a2;
          new import_obsidian7.Notice(`Starting Task #${(_a2 = job.taskNumber) != null ? _a2 : ""} (${job.title})...`);
          await this.plugin.retryJob(job);
          this.render();
        })();
      });
      makeButton(actions, "\u270F Edit", () => {
        this.close();
        window.setTimeout(() => {
          new JobModal(this.app, this.plugin, job, () => {
            new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
          }).open();
        }, 50);
      });
      makeButton(actions, "\u{1F441} Details", () => {
        this.close();
        window.setTimeout(() => {
          new TaskViewModal(this.app, this.plugin, job, () => {
            new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
          }).open();
        }, 50);
      });
    }
  }
  renderAgendaView(container, start, end, occurrencesMap) {
    var _a;
    const agendaCard = makeCard(container, "ai-scheduler-cal-card");
    agendaCard.createEl("h3", {
      text: `Upcoming Task Schedule \u2014 ${MONTH_NAMES2[this.currentMonth + 1]} ${this.currentYear}`,
      cls: "ai-scheduler-cal-panel-title"
    });
    const allOccurrences = [];
    const sortedKeys = Array.from(occurrencesMap.keys()).sort();
    for (const key of sortedKeys) {
      const list = occurrencesMap.get(key) || [];
      for (const occ of list) {
        if (occ.date >= start && occ.date <= end) {
          allOccurrences.push(occ);
        }
      }
    }
    if (allOccurrences.length === 0) {
      const empty = agendaCard.createDiv({ cls: "ai-scheduler-empty" });
      empty.createDiv({ cls: "ai-scheduler-empty-title", text: "No tasks scheduled in this month" });
      empty.createDiv({
        cls: "ai-scheduler-empty-desc",
        text: "Create a scheduled task or use the AI planner to automate your routine."
      });
      return;
    }
    const timeline = agendaCard.createDiv({ cls: "ai-scheduler-cal-agenda-list" });
    let lastDateKey = "";
    for (const occ of allOccurrences) {
      const dateKey = toLocalDateKey(occ.date);
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        const dayHeader = timeline.createDiv({ cls: "ai-scheduler-cal-agenda-date-header" });
        const dayFormatted = `${DAY_NAMES[occ.date.getDay()]}, ${MONTH_NAMES2[occ.date.getMonth() + 1]} ${occ.date.getDate()}`;
        dayHeader.createSpan({ text: dayFormatted });
      }
      const job = occ.job;
      const isRunning = job.status === "running" || this.plugin.runningJobs.has(job.id);
      const row = timeline.createDiv({
        cls: `ai-scheduler-cal-agenda-row ${isRunning ? "is-running" : ""} ${!job.enabled ? "is-paused" : ""}`
      });
      row.createSpan({ cls: "ai-scheduler-cal-agenda-time", text: occ.timeStr });
      const mainCol = row.createDiv({ cls: "ai-scheduler-cal-agenda-main" });
      const titleText = occ.isReview ? "Nightly Review" : `#${(_a = job.taskNumber) != null ? _a : "?"} ${job.title}`;
      mainCol.createDiv({ cls: "ai-scheduler-cal-agenda-title", text: titleText });
      mainCol.createDiv({ cls: "ai-scheduler-cal-agenda-sub", text: `${describeBinding(job)} \xB7 ${describeSchedule(job)}` });
      const actions = row.createDiv({ cls: "ai-scheduler-cal-agenda-actions" });
      makeButton(actions, "\u25B6 Run", () => {
        void (async () => {
          var _a2;
          new import_obsidian7.Notice(`Starting Task #${(_a2 = job.taskNumber) != null ? _a2 : ""}...`);
          await this.plugin.retryJob(job);
          this.render();
        })();
      });
      makeButton(actions, "\u{1F441} View", () => {
        this.close();
        window.setTimeout(() => {
          new TaskViewModal(this.app, this.plugin, job, () => {
            new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
          }).open();
        }, 50);
      });
    }
  }
  renderEventTasksSection(container) {
    var _a;
    const eventJobs = this.plugin.jobs.filter((j) => {
      var _a2;
      return ((_a2 = j.schedule) == null ? void 0 : _a2.kind) === "event";
    });
    if (eventJobs.length === 0) return;
    const card = makeCard(container, "ai-scheduler-cal-event-card");
    const head = card.createDiv({ cls: "ai-scheduler-cal-event-head" });
    head.createEl("h4", { text: `\u26A1 Event-Triggered Tasks (${eventJobs.length})` });
    head.createDiv({
      cls: "ai-scheduler-cal-event-desc",
      text: "These tasks execute automatically whenever vault files change, rather than at a fixed calendar time."
    });
    const list = card.createDiv({ cls: "ai-scheduler-cal-event-list" });
    for (const job of eventJobs) {
      const item = list.createDiv({ cls: "ai-scheduler-cal-event-item" });
      const top = item.createDiv({ cls: "ai-scheduler-cal-event-item-top" });
      top.createSpan({ cls: "ai-scheduler-cal-event-title", text: `#${(_a = job.taskNumber) != null ? _a : "?"} ${job.title}` });
      top.createSpan({
        cls: `ai-scheduler-badge ${job.enabled ? "is-enabled" : "is-disabled"}`,
        text: job.enabled ? "Active on file change" : "Paused"
      });
      const sub = item.createDiv({ cls: "ai-scheduler-cal-event-sub" });
      const cooldown = job.cooldownMinutes ? `${job.cooldownMinutes} min cooldown` : "10 min cooldown";
      sub.createSpan({ text: `${describeBinding(job)} \xB7 Trigger: vault modify \xB7 ${cooldown}` });
      const actions = item.createDiv({ cls: "ai-scheduler-cal-event-actions" });
      makeButton(actions, "\u25B6 Run now", () => {
        void (async () => {
          var _a2;
          new import_obsidian7.Notice(`Starting Task #${(_a2 = job.taskNumber) != null ? _a2 : ""}...`);
          await this.plugin.retryJob(job);
          this.render();
        })();
      });
      makeButton(actions, "\u270F Edit", () => {
        this.close();
        window.setTimeout(() => {
          new JobModal(this.app, this.plugin, job, () => {
            new _CalendarModal(this.app, this.plugin, this.selectedDate).open();
          }).open();
        }, 50);
      });
    }
  }
};

// src/ui/AssistantModal.ts
function appendTaskIdBadge2(container, id2) {
  const idBadge = container.createSpan({ cls: "ai-scheduler-task-id-badge", text: `ID: ${id2}` });
  idBadge.setAttribute("title", "Click to copy task ID");
  idBadge.onclick = (e) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(id2).then(() => {
        new import_obsidian8.Notice(`Copied Task ID: ${id2}`);
      });
    }
  };
}
var ConfirmModal = class extends import_obsidian8.Modal {
  constructor(app, message, onConfirm) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-confirm-modal");
    this.contentEl.createEl("h3", { text: "Confirm" });
    this.contentEl.createEl("p", { text: this.message });
    new import_obsidian8.Setting(this.contentEl).addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close())).addButton((btn) => btn.setButtonText("Confirm").setCta().onClick(() => {
      this.onConfirm();
      this.close();
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var PastDuePromptModal = class extends import_obsidian8.Modal {
  constructor(app, plugin, job, pastTime, onDone) {
    super(app);
    this.plugin = plugin;
    this.job = job;
    this.pastTime = pastTime;
    this.onDone = onDone;
  }
  onOpen() {
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-past-due-modal");
    const head = this.contentEl.createEl("h3", { text: "Scheduled time has passed" });
    head.addClass("ai-scheduler-past-due-title");
    const desc = this.contentEl.createDiv({ cls: "ai-scheduler-past-due-desc" });
    const timeStr = this.pastTime ? formatDate(this.pastTime) : "earlier";
    desc.createEl("p", {
      text: `The scheduled run time for Task #${this.job.taskNumber} (${this.job.title}) was set for ${timeStr}, which is in the past.`
    });
    desc.createEl("p", {
      text: "Would you like to execute this task immediately now, or edit the schedule to pick a new date and time?"
    });
    const actions = this.contentEl.createDiv({ cls: "ai-scheduler-past-due-actions" });
    makeButton(actions, "Run now", () => {
      void (async () => {
        this.close();
        new import_obsidian8.Notice(`Starting task #${this.job.taskNumber} now...`);
        await this.plugin.retryJob(this.job);
        this.onDone();
      })();
    }, true);
    makeButton(actions, "Edit schedule", () => {
      this.close();
      window.setTimeout(() => {
        new JobModal(this.app, this.plugin, this.job, () => {
          this.onDone();
        }).open();
      }, 50);
    });
    makeButton(actions, "Keep disabled", () => {
      this.close();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var AssistantModal = class _AssistantModal extends import_obsidian8.Modal {
  constructor(app, plugin) {
    super(app);
    this.refreshTimer = null;
    this.plugin = plugin;
  }
  onOpen() {
    closeExistingSchedulerModals(this);
    this.render();
    this.refreshTimer = window.setInterval(() => {
      this.render();
    }, 3e3);
  }
  isJobPastDue(job) {
    if (job.schedule.kind === "event") {
      return { isPastDue: false };
    }
    if (job.schedule.kind === "once") {
      const at = job.schedule.at;
      const timeMs = at ? new Date(at).getTime() : NaN;
      if (!Number.isNaN(timeMs) && timeMs <= Date.now()) {
        return { isPastDue: true, originalTime: at };
      }
      return { isPastDue: false };
    }
    const next = getScheduleNextRun(job.schedule, /* @__PURE__ */ new Date());
    if (!next) {
      return { isPastDue: true, originalTime: job.nextRunAt || void 0 };
    }
    return { isPastDue: false };
  }
  render() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-lg");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv("ai-scheduler-shell ai-scheduler-shell-lg");
    shell.createEl("h1", { text: "AI Scheduler" }).addClass("ai-scheduler-title");
    shell.createEl("p", { text: "Plan work, run reviews, and manage scheduled tasks from one place." }).addClass("ai-scheduler-subtitle");
    const readiness = this.plugin.getBackendReadiness();
    if (!readiness.ok) {
      const banner = shell.createDiv("ai-scheduler-alert-banner");
      const content = banner.createDiv("ai-scheduler-alert-content");
      content.createSpan("ai-scheduler-alert-icon").setText("\u26A0\uFE0F");
      const textCol = content.createDiv();
      textCol.createDiv("ai-scheduler-alert-title").setText("AI backend not configured");
      textCol.createDiv("ai-scheduler-alert-desc").setText(readiness.message);
      const btn = banner.createEl("button", { text: "Open settings", cls: "mod-cta ai-scheduler-alert-btn" });
      btn.onclick = () => {
        this.close();
        window.setTimeout(() => {
          this.plugin.openSettingsTab();
        }, 50);
      };
    }
    if (this.plugin.isPlanning) {
      const livePlan = makeCard(shell, "ai-scheduler-planning-live-card");
      const top = livePlan.createDiv({ cls: "ai-scheduler-planning-live-head" });
      top.createSpan({ cls: "ai-scheduler-spinner-tiny" });
      top.createDiv({ cls: "ai-scheduler-planning-live-title", text: "AI is generating a scheduled plan in the background..." });
      if (this.plugin.activePlanningGoal) {
        livePlan.createDiv({ cls: "ai-scheduler-planning-live-goal", text: `Goal: "${this.plugin.activePlanningGoal}"` });
      }
      livePlan.createDiv({ cls: "ai-scheduler-planning-live-sub", text: "Tasks and timing will automatically appear here once planning completes." });
    }
    const actions = shell.createDiv("ai-scheduler-actions");
    makeButton(actions, "Ask AI to plan", () => {
      this.close();
      window.setTimeout(() => {
        new PlannerModal(this.app, this.plugin).open();
      }, 50);
    }, true);
    makeButton(actions, "\u{1F4C5} Calendar", () => {
      this.close();
      window.setTimeout(() => {
        new CalendarModal(this.app, this.plugin).open();
      }, 50);
    });
    makeButton(actions, "Settings", () => {
      this.close();
      window.setTimeout(() => {
        this.plugin.openSettingsTab();
      }, 50);
    });
    const userJobs = this.plugin.jobs.filter((job) => !isNightlyReviewJob(job));
    const activeCount = userJobs.filter((job) => job.enabled).length;
    const pausedCount = userJobs.filter((job) => !job.enabled).length;
    const runningJobs = userJobs.filter((job) => job.status === "running" || this.plugin.runningJobs.has(job.id));
    const next = userJobs.filter((job) => job.enabled && job.nextRunAt && job.status !== "running").sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())[0];
    const stats = shell.createDiv({ cls: "ai-scheduler-stats" });
    const statActive = makeCard(stats, "ai-scheduler-card-stat");
    statActive.createDiv({ cls: "ai-scheduler-stat-value", text: String(activeCount) });
    statActive.createDiv({ cls: "ai-scheduler-stat-label", text: "ACTIVE TASKS" });
    const statPaused = makeCard(stats, "ai-scheduler-card-stat");
    statPaused.createDiv({ cls: "ai-scheduler-stat-value", text: String(pausedCount) });
    statPaused.createDiv({ cls: "ai-scheduler-stat-label", text: "PAUSED / PAST" });
    const statNext = makeCard(stats, "ai-scheduler-card-stat");
    const nextRunDisplay = runningJobs.length > 0 ? "Running now" : next && next.nextRunAt ? formatDate(next.nextRunAt) : "None";
    statNext.createDiv({ cls: "ai-scheduler-stat-value ai-scheduler-stat-sm", text: nextRunDisplay });
    statNext.createDiv({ cls: "ai-scheduler-stat-label", text: "NEXT RUN" });
    if (userJobs.length > 1) {
      const bulkSection = shell.createDiv("ai-scheduler-bulk-section");
      const bulkActions = bulkSection.createDiv("ai-scheduler-bulk-actions");
      makeButton(bulkActions, "Enable all", () => {
        new ConfirmModal(
          this.app,
          "Enable all paused tasks? They will resume their normal schedules.",
          () => {
            void (async () => {
              const count = await this.plugin.enableAllJobs();
              new import_obsidian8.Notice(`Enabled ${count} tasks`);
              this.render();
            })();
          }
        ).open();
      });
      makeButton(bulkActions, "Disable all", () => {
        new ConfirmModal(
          this.app,
          "Disable all tasks? No tasks will run until you re-enable them.",
          () => {
            void (async () => {
              const count = await this.plugin.disableAllJobs();
              new import_obsidian8.Notice(`Disabled ${count} tasks`);
              this.render();
            })();
          }
        ).open();
      });
      makeButton(bulkActions, "Delete all", () => {
        new ConfirmModal(
          this.app,
          `Delete all ${userJobs.length} tasks? They will be moved to Deleted tasks and can be restored.`,
          () => {
            void (async () => {
              const count = await this.plugin.deleteAllJobs();
              new import_obsidian8.Notice(`Deleted ${count} tasks. You can restore them from Deleted tasks.`);
              this.render();
            })();
          }
        ).open();
      }, false, true);
    }
    const enabled = userJobs.filter((job) => job.enabled);
    const scheduledHeading = this.renderSection(shell, "Scheduled tasks", enabled.length ? "Automated runs" : "No tasks scheduled");
    if (enabled.length) {
      const badge = scheduledHeading.createSpan({ cls: "ai-scheduler-count-badge", text: String(enabled.length) });
      badge.addClass("ai-scheduler-badge-count");
    }
    for (const job of enabled) {
      const isRunning = job.status === "running" || this.plugin.runningJobs.has(job.id);
      const card = makeCard(shell, "ai-scheduler-task-card");
      if (isRunning) {
        card.addClass("ai-scheduler-task-card-running");
      }
      const copy = card.createDiv();
      const titleRow = copy.createDiv({ cls: "ai-scheduler-task-header" });
      const titleText = titleRow.createDiv({ cls: "ai-scheduler-task-title", text: `#${job.taskNumber} \xB7 ${job.title}` });
      if (isRunning) {
        titleText.addClass("ai-scheduler-title-running");
      }
      appendTaskIdBadge2(titleRow, job.id);
      copy.createDiv({ cls: "ai-scheduler-task-meta", text: `${describeBinding(job)} \xB7 ${describeSchedule(job)}` });
      if (isRunning) {
        const runningDiv = copy.createDiv({ cls: "ai-scheduler-task-running" });
        const progressRow = runningDiv.createDiv({ cls: "ai-scheduler-running-progress" });
        progressRow.createSpan({ cls: "ai-scheduler-spinner" });
        const progressText = progressRow.createSpan({ cls: "ai-scheduler-running-text" });
        const startIso = job.lastRunAt || job.nextRunAt || (/* @__PURE__ */ new Date()).toISOString();
        const duration = formatDuration(startIso);
        progressText.setText(`Running in background (${duration})...`);
        const liveHint = runningDiv.createDiv({ cls: "ai-scheduler-running-hint" });
        liveHint.setText("AI is executing the prompt. Output will be saved when finished.");
      } else {
        const nextText = job.nextRunAt ? `Next run: ${formatDate(job.nextRunAt)}` : job.schedule.kind === "event" ? "Trigger: On vault note modification" : "Next run: Not scheduled";
        copy.createDiv({ cls: "ai-scheduler-task-next", text: nextText });
      }
      const controls = card.createDiv({ cls: "ai-scheduler-task-actions" });
      if (isRunning) {
        makeButton(controls, "Reset / stop", () => {
          new ConfirmModal(
            this.app,
            `Reset and stop running task #${job.taskNumber} (${job.title})? If the AI backend is currently processing, it will be marked as cancelled/failed.`,
            () => {
              void (async () => {
                await this.plugin.resetRunningJob(job);
                new import_obsidian8.Notice(`Reset task #${job.taskNumber}.`);
                this.render();
              })();
            }
          ).open();
        }, false, true);
      } else {
        makeButton(controls, "Run now", () => {
          new ConfirmModal(
            this.app,
            `Run task #${job.taskNumber} (${job.title}) immediately? This will trigger background execution right now without waiting for its scheduled time slot.`,
            () => {
              void (async () => {
                new import_obsidian8.Notice(`Starting task #${job.taskNumber} now...`);
                await this.plugin.runJobNow(job);
                this.render();
              })();
            }
          ).open();
        });
      }
      makeButton(controls, "Edit", () => {
        this.close();
        window.setTimeout(() => {
          new JobModal(this.app, this.plugin, job, () => {
            new _AssistantModal(this.app, this.plugin).open();
          }).open();
        }, 50);
      });
      if (!isRunning) {
        makeButton(controls, "Disable", async () => {
          job.enabled = false;
          job.nextRunAt = null;
          job.status = "disabled";
          job.lastStatus = "disabled";
          await this.plugin.saveState();
          this.render();
        }, false, false);
      }
      makeButton(controls, "Delete", () => {
        new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
          void (async () => {
            await this.plugin.deleteJob(job);
            new import_obsidian8.Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
            this.render();
          })();
        }).open();
      }, false, true);
    }
    const disabled = summarizeTasks(userJobs.filter((job) => isDisabledTask(job))).reverse();
    if (disabled.length) {
      this.renderSection(shell, "Disabled tasks", "Paused and ready to enable");
      const disabledList = shell.createDiv();
      for (const job of disabled) {
        const card = makeCard(disabledList, "ai-scheduler-task-card");
        const copy = card.createDiv();
        const titleRow = copy.createDiv({ cls: "ai-scheduler-task-header" });
        titleRow.createDiv({ cls: "ai-scheduler-task-title", text: `#${job.taskNumber} \xB7 ${job.title}` });
        appendTaskIdBadge2(titleRow, job.id);
        copy.createDiv({ cls: "ai-scheduler-task-meta", text: `${describeBinding(job)} \xB7 ${describeSchedule(job)}` });
        copy.createDiv({ cls: "ai-scheduler-task-paused", text: "Paused (click Enable to schedule next run)" });
        const controls = card.createDiv({ cls: "ai-scheduler-task-actions" });
        makeButton(controls, "Edit", () => {
          this.close();
          window.setTimeout(() => {
            new JobModal(this.app, this.plugin, job, () => {
              new _AssistantModal(this.app, this.plugin).open();
            }).open();
          }, 50);
        });
        makeButton(controls, "Enable", async () => {
          const pastDue = this.isJobPastDue(job);
          if (pastDue.isPastDue) {
            new PastDuePromptModal(this.app, this.plugin, job, pastDue.originalTime, () => {
              this.render();
            }).open();
            return;
          }
          await this.plugin.enableJob(job);
          this.render();
        });
        makeButton(controls, "Delete", () => {
          new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
            void (async () => {
              await this.plugin.deleteJob(job);
              new import_obsidian8.Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
              this.render();
            })();
          }).open();
        }, false, true);
      }
    }
    const past = summarizeTasks(userJobs.filter((job) => !job.enabled && !isDisabledTask(job))).reverse();
    if (past.length) {
      this.renderSection(shell, "Past tasks", "Completed or failed tasks, summarized per task");
      const pastList = shell.createDiv({ cls: "ai-scheduler-past-tasks-scroll" });
      for (const job of past) {
        const card = makeCard(pastList, "ai-scheduler-task-card");
        const copy = card.createDiv();
        const titleRow = copy.createDiv({ cls: "ai-scheduler-task-header" });
        titleRow.createDiv({ cls: "ai-scheduler-task-title", text: `#${job.taskNumber} \xB7 ${job.title}` });
        appendTaskIdBadge2(titleRow, job.id);
        copy.createDiv({ cls: "ai-scheduler-task-meta", text: `${describeBinding(job)} \xB7 ${job.lastStatus || job.status || "completed"}${job.runCount ? ` \xB7 ${job.runCount} run${job.runCount === 1 ? "" : "s"}` : ""}` });
        if (job.lastRunAt) {
          copy.createDiv({ cls: "ai-scheduler-task-paused", text: `Last ran: ${formatDate(job.lastRunAt)}` });
        }
        const controls = card.createDiv("ai-scheduler-task-actions");
        makeButton(controls, "View", () => {
          this.close();
          window.setTimeout(() => {
            new TaskViewModal(this.app, this.plugin, job, () => {
              new _AssistantModal(this.app, this.plugin).open();
            }).open();
          }, 50);
        });
        makeButton(controls, "Run again", () => {
          new ConfirmModal(
            this.app,
            `Run task #${job.taskNumber} (${job.title}) immediately? It will execute right now in the background and will no longer be marked as past/missed.`,
            () => {
              void (async () => {
                new import_obsidian8.Notice(`Starting task #${job.taskNumber} now...`);
                await this.plugin.retryJob(job);
                this.render();
              })();
            }
          ).open();
        });
        makeButton(controls, "Delete", () => {
          new ConfirmModal(this.app, `Delete task #${job.taskNumber}? It will be moved to Deleted tasks and can be restored.`, () => {
            void (async () => {
              await this.plugin.deleteJob(job);
              new import_obsidian8.Notice(`Deleted task #${job.taskNumber}. You can restore it from Deleted tasks.`);
              this.render();
            })();
          }).open();
        }, false, true);
      }
    }
    if (this.plugin.deletedJobs.length > 0) {
      const deletedHeading = this.renderSection(shell, "Deleted tasks", "Tasks in trash \xB7 Click Restore to recover");
      deletedHeading.createSpan({ cls: "ai-scheduler-count-badge ai-scheduler-badge-count", text: String(this.plugin.deletedJobs.length) });
      const trashActions = shell.createDiv({ cls: "ai-scheduler-row-actions" });
      makeButton(trashActions, "Restore all", () => {
        new ConfirmModal(
          this.app,
          `Restore all ${this.plugin.deletedJobs.length} deleted tasks?`,
          () => {
            void (async () => {
              const count = await this.plugin.restoreAllJobs();
              new import_obsidian8.Notice(`Restored ${count} tasks.`);
              this.render();
            })();
          }
        ).open();
      });
      makeButton(trashActions, "Empty trash", () => {
        new ConfirmModal(
          this.app,
          `Permanently delete all ${this.plugin.deletedJobs.length} tasks in trash? This cannot be undone.`,
          () => {
            void (async () => {
              const count = await this.plugin.emptyTrash();
              new import_obsidian8.Notice(`Permanently deleted ${count} tasks.`);
              this.render();
            })();
          }
        ).open();
      }, false, true);
      const deletedList = shell.createDiv({ cls: "ai-scheduler-deleted-tasks-scroll" });
      for (const job of this.plugin.deletedJobs) {
        const card = makeCard(deletedList, "ai-scheduler-task-card");
        const copy = card.createDiv();
        const titleRow = copy.createDiv({ cls: "ai-scheduler-task-header" });
        titleRow.createDiv({ cls: "ai-scheduler-task-title", text: `#${job.taskNumber} \xB7 ${job.title}` });
        appendTaskIdBadge2(titleRow, job.id);
        titleRow.createSpan({ cls: "ai-scheduler-act-badge ai-scheduler-act-deleted", text: "TRASH" });
        copy.createDiv({ cls: "ai-scheduler-task-meta", text: `${describeBinding(job)} \xB7 ${describeSchedule(job)}` });
        if (job.prompt) {
          const promptSnippet = job.prompt.length > 100 ? `${job.prompt.slice(0, 100)}...` : job.prompt;
          copy.createDiv({ cls: "ai-scheduler-task-prompt", text: promptSnippet });
        }
        const controls = card.createDiv({ cls: "ai-scheduler-task-actions" });
        makeButton(controls, "Restore", () => {
          void (async () => {
            await this.plugin.restoreJob(job);
            new import_obsidian8.Notice(`Restored task #${job.taskNumber}: ${job.title}`);
            this.render();
          })();
        });
        makeButton(controls, "Delete forever", () => {
          new ConfirmModal(
            this.app,
            `Permanently delete task #${job.taskNumber} (${job.title})? This cannot be undone.`,
            () => {
              void (async () => {
                await this.plugin.permanentlyDeleteJob(job);
                new import_obsidian8.Notice(`Permanently deleted task #${job.taskNumber}.`);
                this.render();
              })();
            }
          ).open();
        }, false, true);
      }
    }
    const activity = this.plugin.activity.slice(-10).reverse();
    const activityHeading = this.renderSection(shell, "Recent activity", activity.length ? "All times are local" : "No activity yet");
    makeButton(activityHeading, "Clear", async (button) => {
      button.disabled = true;
      await this.plugin.clearActivity();
      this.render();
    });
    const activityContainer = shell.createDiv("ai-scheduler-activity-scroll-window");
    if (!activity.length) {
      const empty = activityContainer.createDiv("ai-scheduler-activity-empty");
      empty.setText("Reviews, task runs, and notifications will appear here.");
    } else {
      for (const event of activity) {
        const row = activityContainer.createDiv("ai-scheduler-activity-row");
        const left = row.createDiv({ cls: "ai-scheduler-activity-left" });
        const badge = left.createSpan({ cls: `ai-scheduler-act-badge ai-scheduler-act-${event.type || "info"}` });
        badge.setText(this.getActivityTypeLabel(event.type));
        left.createSpan({ text: event.message, cls: "ai-scheduler-activity-msg" });
        if (event.jobId) {
          const idBadge = left.createSpan({ cls: "ai-scheduler-task-id-badge is-clickable", text: `ID: ${event.jobId}` });
          idBadge.setAttribute("title", "Click to view task details and files");
          idBadge.onclick = (e) => {
            e.stopPropagation();
            const target = this.plugin.jobs.find((j) => j.id === event.jobId) || this.plugin.deletedJobs.find((j) => j.id === event.jobId);
            if (target) {
              this.close();
              window.setTimeout(() => {
                new TaskViewModal(this.app, this.plugin, target, () => {
                  new _AssistantModal(this.app, this.plugin).open();
                }).open();
              }, 50);
            } else {
              new import_obsidian8.Notice(`Task ${event.jobId} is no longer available.`);
            }
          };
        }
        row.createSpan({ text: formatDate(event.at) }).addClass("ai-scheduler-activity-time");
      }
    }
  }
  getActivityTypeLabel(type) {
    switch (type) {
      case "running":
        return "RUNNING";
      case "completed":
        return "DONE";
      case "failed":
        return "FAILED";
      case "planned":
        return "PLANNED";
      case "cancelled":
        return "RESET";
      case "deleted":
        return "DELETED";
      case "restored":
        return "RESTORED";
      case "status":
        return "STATUS";
      default:
        return "LOG";
    }
  }
  renderSection(parent, title, description) {
    const heading = parent.createDiv("ai-scheduler-section-heading");
    heading.createEl("h2", { text: title }).addClass("ai-scheduler-section-title");
    heading.createSpan({ text: description }).addClass("ai-scheduler-section-desc");
    return heading;
  }
  onClose() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contentEl.empty();
  }
};

// src/ui/SettingsTab.ts
var import_obsidian10 = require("obsidian");

// src/ui/ChangelogModal.ts
var import_obsidian9 = require("obsidian");

// src/changelog.ts
var CHANGELOG_DATA = [
  {
    version: "2.1.7.15",
    date: "2026-10-07",
    title: "Schedule Calendar View, Default Output Folder, Task Activity Logging & PolyForm License",
    highlights: [
      "Schedule Calendar View: Added an interactive Month Grid and Day Timeline view with status chips, filtering, and instant task actions.",
      'Default Task Output Folder: Unspecified output destinations now automatically route to a configurable default vault folder (defaults to "AI Scheduler").',
      "Centralized Task Activity Logging: Track task runs in a clean Markdown table with serial numbers, timestamps, status, and wikilinks to modified files.",
      "PolyForm Noncommercial 1.0.0 License: Upgraded license terms to PolyForm Noncommercial 1.0.0.",
      "Task Trash & Restoration: Safely recover deleted tasks from a dedicated trash section or with the restore command."
    ],
    added: [
      "Added interactive Schedule Calendar modal with Month Grid and Day Timeline modes.",
      'Added "AI Scheduler: Open schedule calendar" command to the command palette and a calendar button in the dashboard.',
      'Added Default Output Folder setting with automatic fallback to "AI Scheduler".',
      'Added Task Activity Logging setting that writes structured Markdown table entries to "AI SCHEDULER LOGS.md".',
      "Added Deleted Tasks trash section with Restore, Restore all, and Delete forever controls.",
      'Added "AI Scheduler: Restore last deleted task" command.'
    ],
    changed: [
      "Updated license to PolyForm Noncommercial License 1.0.0.",
      "Cleaned branding, removed legacy BRAT references and external donation buttons.",
      "Updated author attributions to @racstan GitHub profile.",
      "Updated README documentation with clean Obsidian Copilot and Claudian setup guides."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.14",
    date: "2026-10-03",
    title: "Rich Cadences (Every N Days/Weeks/Months/Years), Initial Time Anchors & Red Asterisk Highlights",
    highlights: [
      'Rich Scheduling Cadences: Added native support for "every N days", "every N weeks", "every N months", and "yearly / every year".',
      'Bounded Execution (For N Times): Added "Stop after N runs" across all recurring, interval, and cron schedules so tasks finish automatically after N executions.',
      "Initial Starting Time & Date: Configurable starting time (HH:MM) and starting date (YYYY-MM-DD) for interval and recurring cadences.",
      "Red Asterisk & Unspecified Detail Highlights: Added red asterisk markers (*) on mandatory/unspecified fields and AI doubt callout banners."
    ],
    added: [
      "Added support for every N days, every N weeks, monthly/every N months, and yearly schedules.",
      "Added initial starting date/time settings for interval and recurring schedules.",
      "Added red asterisk (*) styling on required form labels and doubt badges for unspecified parameters."
    ],
    changed: [
      "Expanded JobModal schedule editor with dedicated cadence controls and validation.",
      "Enhanced AI Planning Note cards to highlight unmentioned prompt parameters with default values."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.13",
    date: "2026-10-03",
    title: "Dual Edit Modes (Manual / AI), Textarea Content Binding & Time Shorthand Clarifications",
    highlights: [
      "Dedicated Edit Modes (Manual / AI): Added intuitive segmented switcher tabs in the Edit dialog allowing instant switching between manual tweaking and AI-assisted rewriting.",
      "Fixed Empty Prompt/Instructions Textarea: Resolved DOM textarea binding issue so existing prompt instructions and titles are always accurately populated.",
      'Natural Time Parsing & Ambiguity Notes: Added smart natural shorthand parsing (e.g. "150 today" -> 1:50 PM / 13:50) with AI clarification doubt banners.',
      "Optimized Recent Activity Window: Capped recent activity to latest 10 entries to maximize dashboard rendering performance."
    ],
    added: [
      'Added segmented tab switcher in JobModal for "Edit manually" vs "Edit with AI".',
      "Added doubt and clarification tracking for AI-planned tasks with visual callouts and notifications."
    ],
    changed: [
      "Explicitly bound value properties to textarea and input fields in JobModal.",
      "Limited Recent Activity feed to the 10 most recent entries."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.12",
    date: "2026-10-03",
    title: "Scrollable Past Tasks, Live Planning Visibility & Past-Due Edge Case Handling",
    highlights: [
      "Fixed Scrollable Past Tasks Window: Past tasks are now constrained to a clean, fixed-height scrollable window.",
      "Background Planning State & Visibility: Live banner in dashboard and status bar when AI is generating a schedule plan.",
      'Past-Due Enable Warning & Action Modal: Prompts to "Run now" or "Edit schedule" when enabling a task whose scheduled time has passed.',
      "Interactive Task IDs in Activity: Clickable Task ID badges in Recent Activity to open task details and file navigation directly.",
      "Streamlined Button UI: Removed emojis from action buttons for a cleaner, native Obsidian appearance."
    ],
    added: [
      "Added PastDuePromptModal for handling tasks whose run time elapsed while disabled.",
      "Added isPlanning and activePlanningGoal background state tracking and status bar indicator.",
      "Added interactive Task ID navigation in Recent Activity log rows."
    ],
    changed: [
      "Wrapped Past Tasks list in a fixed-height scrollable container.",
      "Sanitized action buttons across AssistantModal, PlannerModal, TaskViewModal, and contextPicker."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.11",
    date: "2026-10-03",
    title: "Past Task View Modal & Vault File Navigation",
    highlights: [
      'Past Tasks Inspection View: Replaced the "Edit" action with a comprehensive "View" modal for completed and past scheduled jobs.',
      "Interactive Vault File Navigation: Instantly view and click to open any file created, modified, synced, or referenced by the task.",
      "Artifact & Output Tracking: Automatically tracks primary output files and generated markdown paths with existence and modification checks.",
      "Full Execution Logs & Response Viewer: Complete prompt preview and AI response inspector with 1-click clipboard copying."
    ],
    added: [
      "Added TaskViewModal with file metadata (size, timestamps, badges) and 1-click vault navigation.",
      "Added lastOutputPath and lastOutputFiles tracking to Job interface and settings persistence."
    ],
    changed: [
      "Replaced Edit button on past task cards with View button in AssistantModal."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.10",
    date: "2026-10-03",
    title: "Obsidian Review Compliance & Release Attestations",
    highlights: [
      "Obsidian Community Review Compliance: Resolved all automated validation errors, warnings, and guidelines for official Obsidian plugin distribution.",
      "Strict Semantic Versioning: Standardized plugin and manifest versions on 3-part SemVer (2.1.8).",
      "Cryptographic Release Attestations: Added automated GitHub Actions build provenance attestations for main.js, manifest.json, and styles.css.",
      "UI & CSS Standards: Replaced all !important CSS rules with specific selectors, adapted UI sentence casing, and standardized setting headers."
    ],
    changed: [
      "Replaced direct element.style modifications and document.createElement in @ mention suggest with Obsidian DOM helpers and dedicated CSS classes.",
      "Updated release workflows with build provenance generation via actions/attest-build-provenance@v2."
    ],
    fixed: [
      "Fixed unhandled floating promises on Task ID clipboard copy buttons across all modal dialogues.",
      "Fixed async callback returns in confirmation dialogs.",
      "Fixed stringification type warnings across backend error handlers."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.9",
    date: "2026-10-02",
    title: "About AI Scheduler & Metadata",
    highlights: [
      "About AI Scheduler Section: Added dedicated project overview, author credits, and license details in Settings.",
      "Documentation & Links: Enriched repository documentation and project metadata."
    ],
    added: [
      'Dedicated "About" section in Settings tab with version info, author metadata, and repository links.',
      "Documentation updates in project README."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.8",
    date: "2026-10-02",
    title: "Task ID Badges, Execution Confirmations & Smart Timeout Protection",
    highlights: [
      "Task ID Display & Copy: Every task card and modal displays a clean ID badge (e.g. ID: job-xxx) that copies to clipboard on click.",
      'Action Confirmations: Added clear confirmation prompts when clicking "Run again", "Run now", or "Reset / Stop" to prevent accidental triggers.',
      "Smart Timeout Protection: Reduced background AI agent timeout to 10 minutes with immediate Claudian tab error detection.",
      "Live Elapsed Duration: Running task status displays real-time elapsed execution timer."
    ],
    added: [
      "Interactive Task ID badges with one-click clipboard copying.",
      'Confirmation dialog on "Run again" for missed/past tasks.',
      'Confirmation dialog on "\u25B6\uFE0F Run now" and "\u23F9\uFE0F Reset / Stop".',
      "Real-time elapsed execution duration timer on active tasks."
    ],
    fixed: [
      "Prevented background execution from hanging indefinitely by enforcing 10-minute timeout and live tab error inspection."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.7",
    date: "2026-10-02",
    title: "Zero-Scroll Changelog Dialog with Always-Visible Action Buttons",
    highlights: [
      'Always-Visible Footer Actions: Pinned "Got it" and "\u2B50 Star on GitHub" buttons at the bottom of the changelog modal without requiring vertical scrolling.',
      "Isolated Middle Scroll Container: Release notes and version history smoothly scroll in the middle while header, tabs, and actions stay anchored."
    ],
    fixed: [
      "Fixed changelog dialog footer getting cut off by outer viewport height."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.6",
    date: "2026-10-02",
    title: "Zero Modal Stacking, Live Execution Indicators, Instant Run & Stop Controls",
    highlights: [
      "Zero Window Stacking: Fixed layered modal stacking across Dashboard, Planner, and Job Editor with clean single-window lifecycle management.",
      'Live Running Progress & Badges: Prominent glowing "\u26A1 Running now..." badges, started timestamps, and real-time dashboard auto-refresh.',
      'Instant "Run Now" & "Reset/Stop" Controls: Manually trigger any scheduled task immediately or reset long-running background tasks.',
      "Detailed Activity Badges: Color-coded status badges for running, completed, failed, planned, and reset activities."
    ],
    added: [
      "Live running badges with pulsating glow and spinner for active background tasks.",
      'Instant "\u25B6\uFE0F Run now" button on scheduled tasks.',
      'Direct "\u23F9\uFE0F Reset / Stop" button for active background jobs.',
      "Automated 3-second live refresh on open dashboard modals.",
      "Color-coded activity log tags and start-of-execution activity logging."
    ],
    fixed: [
      "Fixed modal stacking and dual close button layering across all dialogs.",
      'Fixed misleading "Next run: <past time>" timestamp during background execution.'
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author & Lead Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.5",
    date: "2026-10-02",
    title: "AI Planning Loading Animation, Interactive Plan Review & Direct Task Editing",
    highlights: [
      "AI Planning Loading Animation: Beautiful glowing pulse card and spinner showing real-time feedback while AI generates schedules.",
      'Interactive Planned Tasks Review: Direct "\u270F\uFE0F Edit" and "\u{1F5D1}\uFE0F Discard" buttons on each generated task card before finalizing.',
      'Once Schedule Description Fix: Fixed "not scheduled" label bug on one-time scheduled tasks.'
    ],
    added: [
      "Pulsing glow and spinner animation during AI plan generation.",
      "Per-task edit and discard controls directly on the AI Planner review screen.",
      "Discard all button on the planning review screen."
    ],
    fixed: [
      'Fixed describeSchedule rendering "not scheduled" for one-time (once) tasks.'
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.4",
    date: "2026-10-02",
    title: "Prompt @ Mentions, Modern Context Chips, Back Navigation & Task Directory Structure",
    highlights: [
      'Prompt @ Mentions Autocomplete: Type "@" in any planning or editing prompt to quickly search and attach vault notes directly.',
      "Modern Context & Attachments UI: Replaced legacy multi-select with interactive visual tag chips and native fuzzy file/folder attachment modals.",
      'Seamless Modal Navigation: Added "\u2190 Back to dashboard" navigation buttons inside AI Planner and Task Editor modals.',
      "Self-Contained Task Directories: Each schedule note is organized with dedicated task folders and attachment directories."
    ],
    added: [
      'Interactive "@" mention autocomplete dropdown for vault files in prompt textareas.',
      "Native FuzzySuggest modals for attaching individual files, active notes, and vault folders.",
      "Top header back button to easily navigate between Planner/Editor and the Dashboard.",
      "Dedicated attachments folder structure for scheduled tasks."
    ],
    changed: [
      'Removed "Recommended" tag from Claudian backend dropdown for neutral backend selection.',
      "Eliminated multi-select box hover selection bugs with modern tag chips."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.3",
    date: "2026-10-02",
    title: "Changelog Lifecycle Polish, Zero-Task Edge Cases & Conditional Review Settings",
    highlights: [
      "Reliable Changelog Lifecycle: Release notes display strictly once per update on normal workspace startup, never interrupting settings navigation or reloads.",
      'Zero-Task Edge Case Handling: Clean feedback notification ("No tasks available") when bulk enabling, disabling, or deleting with an empty list.',
      "Conditional Reviews Section: Daily & Nightly Review settings dynamically hide when no AI backend is active.",
      "Comprehensive Nightly Review Documentation: Enhanced explanations of autonomous end-of-day synthesis and timestamped vault report storage."
    ],
    added: [
      "Zero-task guard and toast notices across dashboard bulk actions and command palette.",
      "Layout-ready event scheduling for update changelog modals."
    ],
    changed: [
      "Daily & Nightly Reviews settings section only renders when Claudian or Copilot backend is active.",
      "Enriched descriptions for Nightly AI Review explaining nightly synthesis and timestamped note archives."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.2",
    date: "2026-10-02",
    title: "Native Desktop Notifications, Bulk Actions Feedback & Confirmations",
    highlights: [
      "Native Desktop / System Notifications: Real OS desktop notifications on Windows, macOS, and Linux when tasks complete or fail.",
      'Bulk Actions Confirmation & Feedback: "Enable all" now requires confirmation, and bulk enable/disable/delete actions display exact count toasts.',
      "Enhanced Notifications Settings: Dedicated toggles for in-app notices, system desktop notifications, and a full testing utility."
    ],
    added: [
      "Native desktop notification integration using the Web/Electron Notification API.",
      "Confirmation dialog before enabling all scheduled tasks in bulk.",
      "Exact task count notifications when enabling, disabling, or deleting tasks.",
      "System desktop notifications toggle under Background Execution & Notifications settings."
    ],
    changed: [
      "Test notification button now triggers both in-app and system desktop alerts to verify OS permissions."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.7.1",
    date: "2026-10-02",
    title: "Dynamic AI Backend Configuration, Categorized Settings & UI Polish",
    highlights: [
      "Dynamic AI Backend Configuration: Unconfigured/None mode with clear guidance and conditional model visibility.",
      "Categorized Settings: Clean visual sections for AI Backend, Execution & Reliability, Reviews, and Markdown Sync.",
      "Per-Task Next Run Visibility: Explicit next run timestamps displayed on each task card.",
      "Theme & Modal Fixes: Seamless dark/light theme styling and modal stability fixes."
    ],
    added: [
      'Default unselected placeholder in AI backend dropdown ("Select an AI backend...").',
      "Per-task next run indicator in dashboard cards and scheduled task list.",
      "Categorized settings layout with intuitive section headers and descriptions."
    ],
    changed: [
      "Backend model pickers dynamically show or hide based on the active backend.",
      "Refined dark and light mode contrast across all modal views."
    ],
    fixed: [
      "Fixed DOM class token parsing exceptions in Planner and Job modals.",
      "Fixed ambiguous dashboard next run stat clarity."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.7",
    date: "2026-09-30",
    title: "Planner UI Overhaul, Backend Readiness Alerts & Settings Shortcuts",
    highlights: [
      "Redesigned AI Planner: Clean, unstacked dialog with direct prompt-first goal input and spacious responsive layout.",
      "Backend Readiness Alerts: Prominent warning banner when AI backend or models are unconfigured with 1-click navigation to Settings.",
      "Fixed Scrollable Activity Window: Encapsulated recent activity logs into a fixed-height scrollable window.",
      "Streamlined Dashboard: Added a direct Settings button and moved on-demand review actions to the Settings tab."
    ],
    added: [
      'Direct "Open settings" button in the main AI Scheduler dashboard header.',
      "Backend configuration check and warning banner on dashboard, planner, and job editor.",
      'Dedicated "Daily & nightly reviews" section in Settings with instant preview and review buttons.'
    ],
    fixed: [
      "Fixed modal stacking behavior when opening the AI Planner from the dashboard.",
      "Fixed modal sizing and layout clipping across planner and task editor modals.",
      "Fixed YAML frontmatter delimiter formatting and note cleanup on task deletion.",
      "Fixed cron multi-time conversion and range stepping math."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      }
    ]
  },
  {
    version: "2.1.6",
    date: "2026-09-30",
    title: "In-App Changelog System, Stability Hardening & GPL-3.0",
    highlights: [
      'In-App Changelog System: Automatically shows release notes after plugin updates with full history view and a "never show again" option.',
      "License Upgrade to GNU GPLv3: Strong copyleft protections, author attribution requirements, and open-source guarantees.",
      "Resilient Event Queueing: Vault events fired during active executions are now queued rather than dropped."
    ],
    added: [
      "Interactive What's new / changelog modal dialog with complete version timeline.",
      `"AI Scheduler: View changelog / what's new" command and Settings button.`,
      "Setting toggle to control whether changelogs appear automatically on update.",
      "Community help & issue reporter shortcut directly in Settings."
    ],
    fixed: [
      "Fixed plugin default export compatibility for Obsidian loader (thanks @leweii in PR #2).",
      "Prevented timer memory leaks by clearing timeout handles on AI completions.",
      "Fixed folder collision when writing reports/outputs to a path matching an existing folder.",
      "Sanitized review context folder trailing slashes to prevent accidental file inclusion.",
      "Validated AI-generated task schemas and bounded recursive follow-ups to 100 jobs max.",
      "Added safe error handling around plugin state persistence."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Maintainer"
      },
      {
        name: "Jakob He",
        username: "leweii",
        url: "https://github.com/leweii",
        role: "Contributor (PR #2)"
      }
    ]
  },
  {
    version: "2.1.5",
    date: "2026-09-30",
    title: "Critical Stability, Memory Leaks & Validation Hardening",
    highlights: [
      "Resolved background timeout leaks during long-running AI requests.",
      "Enforced validation schemas on AI-generated follow-up jobs and schedule plans."
    ],
    fixed: [
      "Cleared active timers in AI communication handlers upon completion.",
      "Added total job limit guardrail (max 100) to prevent unbounded recursive self-talk.",
      "Hardened vault state writes with comprehensive error handling.",
      "Validated context paths before sending planning prompts."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.1.4",
    date: "2026-09-08",
    title: "Community Plugin Manifest Compliance",
    fixed: [
      'Removed redundant "Obsidian" prefix in manifest description in compliance with Community Plugin review rules.'
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.1.3",
    date: "2026-09-06",
    title: "Strict TypeScript Architecture & Official Linting Readiness",
    highlights: [
      "100% strict TypeScript types across all Claudian and Obsidian Copilot integration bridges.",
      "Zero ESLint warnings under official eslint-plugin-obsidianmd ruleset."
    ],
    added: [
      "Type-safe bridge interfaces for Claudian and Obsidian Copilot internals.",
      "Safe profile parsers and tab resolution helpers."
    ],
    changed: [
      "Decoupled settings re-render lifecycles to eliminate deprecation warnings.",
      "Standardized UI copy to Obsidian sentence-case conventions."
    ],
    fixed: [
      "Unhandled type coercion in clock parsers for non-string values."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.1.2",
    date: "2026-09-06",
    title: "Native Accessible Dialogs",
    added: [
      "Native Obsidian ConfirmModal for destructive actions (job deletion, bulk disable, bulk delete).",
      "Declarative setting definitions for forward compatibility."
    ],
    fixed: [
      "Hardened multi-rule JSON deserialization with safe unknown type assertions.",
      "Improved clock string regex matching on edge-case inputs."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.1.1",
    date: "2026-09-05",
    title: "Zero-Dependency Cron Engine & Two-Way Synced Schedule Notes",
    highlights: [
      "Pure 5-field cron scheduling engine bundled directly into the plugin source.",
      "Two-way synced Markdown notes in AI Schedules/ with YAML frontmatter sync.",
      "DST-safe scheduling arithmetic skipping invalid wall times."
    ],
    added: [
      "Full 5-field cron expression support (minute hour dom month dow) with live validation.",
      "Startup catch-up engine to evaluate jobs due while Obsidian was closed.",
      "Run recovery mechanism to gracefully reset interrupted tasks."
    ],
    changed: [
      "Rebuilt entire plugin core from modular TypeScript sources with esbuild bundling.",
      "Added comprehensive unit test suite covering cron math and execution state machines."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.1.0",
    date: "2026-08-22",
    title: "Dual Backend Architecture & Task Context Binding",
    highlights: [
      "Native support for Obsidian Copilot alongside Claudian.",
      "Contextual note and folder binding for scheduled tasks."
    ],
    added: [
      "Dual backend switch in settings (Claudian or Obsidian Copilot).",
      "Interval schedules (every N minutes or hours with bounded iteration limits).",
      "Vault project folder and active note context binding.",
      "Custom output routing to dedicated vault folders."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.0.4",
    date: "2026-08-22",
    title: "Automated CI Pipeline & Smoke Testing",
    added: [
      "Automated GitHub Actions release pipeline.",
      "Smoke testing harness against mock Obsidian runtime."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.0.3",
    date: "2026-08-22",
    title: "Redesigned Assistant Dashboard",
    changed: [
      "Categorized dashboard tabs: Active Tasks, Disabled Tasks, and Past Completed Tasks.",
      "Task numbering (#1, #2...) and visual context badges (Independent vs Project-based)."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.0.2",
    date: "2026-08-22",
    title: "Multi-Model Routing Profiles",
    added: [
      "Configure separate AI models for Planning, Task Execution, Daily Previews, and Nightly Reviews.",
      "Live model refresher button in settings."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.0.1",
    date: "2026-08-21",
    title: "Session Persistence & Namespace Polish",
    fixed: [
      "Claudian conversation persistence and session lifecycle management.",
      "Standardized CSS class namespaces under ai-scheduler."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  },
  {
    version: "2.0.0",
    date: "2026-08-21",
    title: "Initial Release of AI Scheduler",
    highlights: [
      "First autonomous background scheduling and proactive intelligence engine for Obsidian.",
      "Automate recurring prompts, vault maintenance, and nightly reviews."
    ],
    contributors: [
      {
        name: "racstan",
        username: "racstan",
        url: "https://github.com/racstan",
        role: "Author"
      }
    ]
  }
];
function getLatestRelease() {
  return CHANGELOG_DATA[0];
}
function getReleasesSince(previousVersion) {
  if (!previousVersion) return [CHANGELOG_DATA[0]];
  const index = CHANGELOG_DATA.findIndex((r) => r.version === previousVersion);
  if (index === -1) {
    return [CHANGELOG_DATA[0]];
  }
  if (index === 0) {
    return [CHANGELOG_DATA[0]];
  }
  return CHANGELOG_DATA.slice(0, index);
}

// src/ui/ChangelogModal.ts
var ChangelogModal = class extends import_obsidian9.Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.viewMode = "recent";
    this.plugin = plugin;
    this.options = options;
  }
  onOpen() {
    closeExistingSchedulerModals(this);
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-md");
    this.modalEl.addClass("ai-scheduler-changelog-window");
    contentEl.empty();
    contentEl.addClass("ai-scheduler-changelog-modal");
    const currentVersion = this.options.currentVersion || this.plugin.manifest.version;
    const fromVersion = this.options.fromVersion;
    const headerEl = contentEl.createDiv({ cls: "ai-scheduler-changelog-header" });
    const titleEl = headerEl.createEl("h2", { text: "\u2728 What's new in AI Scheduler" });
    titleEl.addClass("ai-scheduler-changelog-title");
    const subtext = fromVersion && fromVersion !== currentVersion ? `Updated from v${fromVersion} \u2192 v${currentVersion}` : `Version v${currentVersion}`;
    headerEl.createEl("p", { text: subtext, cls: "ai-scheduler-changelog-subtitle" });
    const tabRow = contentEl.createDiv({ cls: "ai-scheduler-changelog-tabs" });
    const recentBtn = tabRow.createEl("button", {
      text: fromVersion && fromVersion !== currentVersion ? "Changes in this update" : `v${currentVersion} highlights`,
      cls: `ai-scheduler-tab-btn ${this.viewMode === "recent" ? "is-active" : ""}`
    });
    const allBtn = tabRow.createEl("button", {
      text: "Full version history",
      cls: `ai-scheduler-tab-btn ${this.viewMode === "all" ? "is-active" : ""}`
    });
    const listContainer = contentEl.createDiv({ cls: "ai-scheduler-changelog-content" });
    const renderList = () => {
      listContainer.empty();
      recentBtn.toggleClass("is-active", this.viewMode === "recent");
      allBtn.toggleClass("is-active", this.viewMode === "all");
      const releases = this.viewMode === "recent" ? getReleasesSince(fromVersion) : CHANGELOG_DATA;
      for (const release of releases) {
        this.renderReleaseCard(listContainer, release);
      }
    };
    recentBtn.addEventListener("click", () => {
      this.viewMode = "recent";
      renderList();
    });
    allBtn.addEventListener("click", () => {
      this.viewMode = "all";
      renderList();
    });
    renderList();
    const footerEl = contentEl.createDiv({ cls: "ai-scheduler-changelog-footer" });
    new import_obsidian9.Setting(footerEl).setName("Show changelog after future updates").setDesc("Automatically open this dialog when AI Scheduler is updated.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.showChangelogOnUpdate).onChange(async (val) => {
        this.plugin.settings.showChangelogOnUpdate = val;
        await this.plugin.saveState();
      });
    });
    const actionsRow = footerEl.createDiv({ cls: "ai-scheduler-changelog-actions" });
    const leftActions = actionsRow.createDiv({ cls: "ai-scheduler-changelog-left-actions" });
    const starBtn = leftActions.createEl("button", {
      text: "\u2B50 Star on GitHub",
      cls: "ai-scheduler-star-btn"
    });
    starBtn.addEventListener("click", () => {
      window.open("https://github.com/racstan/obsidian-ai-scheduler", "_blank");
    });
    const closeBtn = actionsRow.createEl("button", {
      text: "Got it",
      cls: "mod-cta ai-scheduler-close-btn"
    });
    closeBtn.addEventListener("click", () => this.close());
  }
  renderReleaseCard(parent, release) {
    const card = parent.createDiv({ cls: "ai-scheduler-release-card" });
    const header = card.createDiv({ cls: "ai-scheduler-release-header" });
    const titleRow = header.createDiv({ cls: "ai-scheduler-release-title-row" });
    const badge = titleRow.createSpan({ cls: "ai-scheduler-version-badge", text: `v${release.version}` });
    if (release.version === getLatestRelease().version) {
      badge.addClass("is-latest");
    }
    titleRow.createSpan({ cls: "ai-scheduler-release-name", text: release.title });
    header.createSpan({ cls: "ai-scheduler-release-date", text: release.date });
    if (release.highlights && release.highlights.length) {
      const hlBox = card.createDiv({ cls: "ai-scheduler-release-highlights" });
      hlBox.createDiv({ cls: "ai-scheduler-changelog-section-heading", text: "\u2728 Highlights" });
      const ul = hlBox.createEl("ul");
      for (const hl of release.highlights) {
        ul.createEl("li", { text: hl });
      }
    }
    if (release.added && release.added.length) {
      const section = card.createDiv({ cls: "ai-scheduler-release-section" });
      section.createDiv({ cls: "ai-scheduler-changelog-section-heading added", text: "\u{1F7E2} Added" });
      const ul = section.createEl("ul");
      for (const item of release.added) {
        ul.createEl("li", { text: item });
      }
    }
    if (release.changed && release.changed.length) {
      const section = card.createDiv({ cls: "ai-scheduler-release-section" });
      section.createDiv({ cls: "ai-scheduler-changelog-section-heading changed", text: "\u{1F7E1} Changed" });
      const ul = section.createEl("ul");
      for (const item of release.changed) {
        ul.createEl("li", { text: item });
      }
    }
    if (release.fixed && release.fixed.length) {
      const section = card.createDiv({ cls: "ai-scheduler-release-section" });
      section.createDiv({ cls: "ai-scheduler-changelog-section-heading fixed", text: "\u{1F6E0}\uFE0F Fixed" });
      const ul = section.createEl("ul");
      for (const item of release.fixed) {
        ul.createEl("li", { text: item });
      }
    }
    if (release.contributors && release.contributors.length) {
      const section = card.createDiv({ cls: "ai-scheduler-release-section" });
      section.createDiv({ cls: "ai-scheduler-changelog-section-heading contributors", text: "\u{1F465} Contributors" });
      const list = section.createDiv({ cls: "ai-scheduler-contributors-list" });
      for (const contributor of release.contributors) {
        const chip = list.createEl("a", {
          cls: "ai-scheduler-contributor-chip",
          href: contributor.url
        });
        chip.target = "_blank";
        chip.createSpan({ cls: "ai-scheduler-contributor-name", text: contributor.name });
        if (contributor.username && contributor.username !== contributor.name) {
          chip.createSpan({ cls: "ai-scheduler-contributor-handle", text: ` (@${contributor.username})` });
        }
        if (contributor.role) {
          chip.createSpan({ cls: "ai-scheduler-contributor-role", text: ` \xB7 ${contributor.role}` });
        }
      }
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};

// src/ui/SettingsTab.ts
var AssistantSettingTab = class extends import_obsidian10.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  getSettingDefinitions() {
    return [];
  }
  renderBackendStatus(containerEl) {
    const mode = this.plugin.settings.backendMode;
    if (mode === "none" || !mode) return;
    const info = BACKEND_INFO[mode === "copilot" ? "copilot" : "claudian"];
    const setting = new import_obsidian10.Setting(containerEl).setName("Backend connection status").setDesc("Checking readiness...");
    const update = (result) => {
      setting.setDesc("");
      const desc = setting.descEl;
      desc.empty();
      desc.addClass(result.ok ? "ai-scheduler-status-ok" : "ai-scheduler-status-error");
      desc.createSpan({ text: result.message });
      if (!result.ok && result.needsInstall) {
        desc.createSpan({ text: " " });
        const link = desc.createEl("a", { text: `Open ${info.name} on GitHub`, href: result.githubUrl || info.githubUrl });
        link.target = "_blank";
      }
    };
    const installed = mode === "copilot" ? Boolean(this.plugin.getCopilotPlugin()) : Boolean(this.plugin.getClaudianPlugin());
    if (!installed) {
      update({ ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl });
      return;
    }
    void Promise.resolve(this.plugin.checkBackendSetup()).then(update).catch((error) => {
      update({ ok: false, needsInstall: false, message: errorText(error), githubUrl: info.githubUrl });
    });
  }
  display() {
    this.renderSettings();
  }
  renderSettings() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian10.Setting(containerEl).setName("AI backend & models").setHeading();
    containerEl.createEl("p", {
      text: "Choose which AI plugin AI Scheduler uses to execute tasks, plan schedules, and generate reviews.",
      cls: "ai-scheduler-subtitle"
    });
    new import_obsidian10.Setting(containerEl).setName("AI backend").setDesc("Select Claudian (for claude and custom providers) or Obsidian Copilot (for OpenAI, gemini, ollama, etc.).").addDropdown((dropdown) => dropdown.addOption("none", "Select an AI backend...").addOption("claudian", "Claudian").addOption("copilot", "Obsidian Copilot").setValue(this.plugin.settings.backendMode || "none").onChange((value) => {
      void (async () => {
        this.plugin.settings.backendMode = value;
        await this.plugin.saveState();
        this.renderSettings();
      })();
    }));
    const mode = this.plugin.settings.backendMode;
    if (mode === "none" || !mode) {
      const infoBox = containerEl.createDiv({ cls: "ai-scheduler-card ai-scheduler-card-flush" });
      infoBox.createDiv({
        cls: "ai-scheduler-hint",
        text: "\u{1F449} Select an AI backend above to configure your AI models and connections. AI Scheduler connects to your installed Claudian or Obsidian Copilot plugin."
      });
    } else if (mode === "copilot") {
      this.renderBackendStatus(containerEl);
      const infoBox = containerEl.createDiv({ cls: "ai-scheduler-card ai-scheduler-card-flush" });
      infoBox.createDiv({
        cls: "ai-scheduler-hint",
        text: "Obsidian Copilot uses the active model and provider configured inside the Copilot plugin settings."
      });
    } else if (mode === "claudian") {
      this.renderBackendStatus(containerEl);
      new import_obsidian10.Setting(containerEl).setName("Available Claudian models").setDesc("Refresh this list after adding, removing, or changing models in Claudian.").addButton((button) => button.setButtonText("Refresh models").onClick(() => {
        void (async () => {
          button.setDisabled(true);
          try {
            await this.plugin.refreshModels();
            new import_obsidian10.Notice("Claudian model list refreshed.");
            this.renderSettings();
          } catch (error) {
            new import_obsidian10.Notice(`Could not refresh models: ${errorText(error)}`, 8e3);
            button.setDisabled(false);
          }
        })();
      }));
      const models = this.plugin.getModelOptions();
      const addModelSetting = (name, desc, key) => new import_obsidian10.Setting(containerEl).setName(name).setDesc(desc).addDropdown((dropdown) => {
        dropdown.addOption("", models.length ? "Select a model" : "No models found - open Claudian");
        models.forEach((model) => {
          dropdown.addOption(model.value, model.label);
        });
        const selected = this.plugin.settings[key] || "";
        dropdown.setValue(models.some((model) => model.value === selected) ? selected : "");
        dropdown.onChange((value) => {
          void (async () => {
            this.plugin.settings[key] = value;
            await this.plugin.saveState();
          })();
        });
      });
      addModelSetting("Planning model", "Used when Ask AI to plan creates tasks and when AI updates a task.", "planningModel");
      addModelSetting("Scheduled task model", "Used when an enabled task runs, including tasks created by the planner.", "executionModel");
      addModelSetting("Daily preview model", "Used by Run daily preview.", "dailyReviewModel");
      if (this.plugin.settings.nightlyReviewEnabled) {
        addModelSetting("Nightly review model", "Used by the recurring nightly review and the Run AI nightly review now command.", "nightlyReviewModel");
      }
    }
    if (mode && mode !== "none") {
      new import_obsidian10.Setting(containerEl).setName("Daily & nightly reviews").setHeading();
      containerEl.createEl("p", {
        text: "Autonomous vault intelligence: Synthesizes notes created or modified during the day and saves timestamped Markdown reports in your review folder.",
        cls: "ai-scheduler-subtitle"
      });
      new import_obsidian10.Setting(containerEl).setName("Review context").setDesc("Files the daily and nightly reviews may inspect through the active backend's vault tools.").addDropdown((dropdown) => dropdown.addOption("modified-today", "Markdown files modified today").addOption("all-markdown", "All Markdown files").addOption("no-files", "No automatic files").setValue(this.plugin.settings.reviewContextMode).onChange((value) => {
        void (async () => {
          this.plugin.settings.reviewContextMode = value;
          await this.plugin.saveState();
        })();
      }));
      new import_obsidian10.Setting(containerEl).setName("Review report folder").setDesc("Vault folder where daily and nightly review summaries are saved (default: AI reviews). Each review creates a timestamped Markdown file (e.g. YYYY-MM-DD-HHmmss.md) so past summaries are permanently preserved.").addText((text) => text.setValue(this.plugin.settings.reportFolder).onChange((value) => {
        void (async () => {
          this.plugin.settings.reportFolder = value.trim() || "AI Reviews";
          await this.plugin.saveState();
        })();
      }));
      new import_obsidian10.Setting(containerEl).setName("Run daily preview now").setDesc("Immediately synthesize notes modified today and generate a preview review summary in your review folder.").addButton((button) => button.setButtonText("Run preview now").onClick(() => {
        void this.plugin.startReviewRun(true, "daily");
      }));
      new import_obsidian10.Setting(containerEl).setName("Nightly AI review").setDesc("Automated end-of-day synthesis: Runs in the background (e.g., at night while you sleep) to review everything you created or modified during the day, saving timestamped summaries to your review folder.").addToggle((toggle) => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange((value) => {
        void (async () => {
          const previous = this.plugin.settings.nightlyReviewEnabled;
          try {
            this.plugin.settings.nightlyReviewEnabled = value;
            await this.plugin.ensureNightlyReviewJob();
            await this.plugin.saveState();
            new import_obsidian10.Notice(value ? "Nightly review enabled." : "Nightly review disabled.");
            this.renderSettings();
          } catch (error) {
            this.plugin.settings.nightlyReviewEnabled = previous;
            toggle.setValue(previous);
            new import_obsidian10.Notice(`Could not change nightly review: ${errorText(error)}`, 8e3);
          }
        })();
      }));
      if (this.plugin.settings.nightlyReviewEnabled) {
        new import_obsidian10.Setting(containerEl).setName("Nightly review schedule time").setDesc("Local 24-hour time when the nightly review runs automatically (for example, 22:00 or 23:30).").addText((text) => text.setValue(this.plugin.settings.reviewTime).onChange((value) => {
          void (async () => {
            if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) this.plugin.settings.reviewTime = value;
            await this.plugin.ensureNightlyReviewJob();
            await this.plugin.saveState();
          })();
        }));
        new import_obsidian10.Setting(containerEl).setName("Run nightly review now").setDesc("Manually trigger the full end-of-day nightly review routine immediately without waiting for the scheduled hour.").addButton((button) => button.setButtonText("Run review now").onClick(() => {
          void this.plugin.startReviewRun(true, "nightly");
        }));
      }
    }
    new import_obsidian10.Setting(containerEl).setName("Task outputs & activity logging").setHeading();
    new import_obsidian10.Setting(containerEl).setName("Default output folder").setDesc('Vault folder where AI task results are saved when a prompt does not specify a save location. If empty, defaults to "AI Scheduler".').addText((text) => text.setPlaceholder("AI Scheduler").setValue(this.plugin.settings.defaultOutputFolder).onChange((value) => {
      void (async () => {
        this.plugin.settings.defaultOutputFolder = value.trim();
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian10.Setting(containerEl).setName("Enable task activity logging").setDesc("Record every task execution in a centralized Markdown log table with serial number, timestamp, execution status, and links to modified/created files.").addToggle((toggle) => toggle.setValue(this.plugin.settings.taskLoggingEnabled).onChange((value) => {
      void (async () => {
        this.plugin.settings.taskLoggingEnabled = value;
        await this.plugin.saveState();
        this.renderSettings();
      })();
    }));
    if (this.plugin.settings.taskLoggingEnabled) {
      new import_obsidian10.Setting(containerEl).setName("Task log folder").setDesc('Vault folder where "AI SCHEDULER LOGS.md" is stored. Leave blank to use the default output folder.').addText((text) => text.setPlaceholder(this.plugin.getDefaultOutputFolder()).setValue(this.plugin.settings.taskLogFolder).onChange((value) => {
        void (async () => {
          this.plugin.settings.taskLogFolder = value.trim();
          await this.plugin.saveState();
        })();
      }));
    }
    new import_obsidian10.Setting(containerEl).setName("Background execution & notifications").setHeading();
    new import_obsidian10.Setting(containerEl).setName("In-app completion notices").setDesc("Show an Obsidian notice when an AI job or review finishes.").addToggle((toggle) => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange((value) => {
      void (async () => {
        this.plugin.settings.notifyOnCompletion = value;
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian10.Setting(containerEl).setName("System desktop notifications").setDesc("Send native os desktop notifications (windows / macOS / linux) when tasks finish or fail.").addToggle((toggle) => toggle.setValue(this.plugin.settings.systemNotifications).onChange((value) => {
      void (async () => {
        this.plugin.settings.systemNotifications = value;
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian10.Setting(containerEl).setName("Test notifications").setDesc("Send a test alert to verify both Obsidian in-app notices and system desktop notifications.").addButton((button) => button.setButtonText("Send test notification").onClick(() => this.plugin.testNotification()));
    new import_obsidian10.Setting(containerEl).setName("Run missed jobs after startup").setDesc("Off by default. Enable only if you explicitly want AI work to run after Obsidian was closed.").addToggle((toggle) => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange((value) => {
      void (async () => {
        this.plugin.settings.catchUpOnStart = value;
        await this.plugin.saveState();
        this.renderSettings();
      })();
    }));
    if (this.plugin.settings.catchUpOnStart) {
      new import_obsidian10.Setting(containerEl).setName("Startup catch-up window (hours)").setDesc("Only jobs missed within this window will run after startup.").addText((text) => text.setValue(String(this.plugin.settings.catchUpHours)).onChange((value) => {
        void (async () => {
          this.plugin.settings.catchUpHours = Math.max(1, Number.parseInt(value, 10) || 24);
          await this.plugin.saveState();
        })();
      }));
    }
    new import_obsidian10.Setting(containerEl).setName("Vault schedule notes (optional)").setHeading();
    new import_obsidian10.Setting(containerEl).setName("Keep schedule notes in my vault").setDesc("Off by default. When enabled, every task gets a Markdown note whose frontmatter holds its schedule and prompt \u2014 edit the note or the dashboard, both stay in sync. Note: deleting a task note in Obsidian permanently removes that task.").addToggle((toggle) => toggle.setValue(this.plugin.settings.scheduleNotesEnabled).onChange((value) => {
      void (async () => {
        this.plugin.settings.scheduleNotesEnabled = value;
        await this.plugin.saveState();
        if (value) {
          try {
            const written = await this.plugin.notesSync.syncAll();
            new import_obsidian10.Notice(written ? `Schedule notes created or updated in ${this.plugin.settings.scheduleFolder}.` : "Schedule notes are up to date.");
          } catch (error) {
            new import_obsidian10.Notice(`Could not write schedule notes: ${errorText(error)}`, 8e3);
          }
        }
        this.renderSettings();
      })();
    }));
    if (this.plugin.settings.scheduleNotesEnabled) {
      new import_obsidian10.Setting(containerEl).setName("Schedule notes folder").setDesc("Existing notes keep working after a rename of this folder; new notes are created here.").addText((text) => text.setValue(this.plugin.settings.scheduleFolder).onChange((value) => {
        void (async () => {
          this.plugin.settings.scheduleFolder = value.trim() || "AI Schedules";
          await this.plugin.saveState();
        })();
      }));
      new import_obsidian10.Setting(containerEl).setName("Sync notes now").setDesc("Reconcile all task notes with the current schedule, including notes created by hand.").addButton((button) => button.setButtonText("Sync now").onClick(() => {
        void (async () => {
          button.setDisabled(true);
          try {
            const written = await this.plugin.notesSync.syncAll();
            new import_obsidian10.Notice(written ? `${written} note(s) reconciled.` : "All schedule notes are up to date.");
          } catch (error) {
            new import_obsidian10.Notice(`Could not sync schedule notes: ${errorText(error)}`, 8e3);
          }
          button.setDisabled(false);
        })();
      }));
    }
    new import_obsidian10.Setting(containerEl).setName("Updates & release notes").setHeading();
    new import_obsidian10.Setting(containerEl).setName("Show changelog after updates").setDesc("Automatically open the what's new dialog when AI Scheduler is updated.").addToggle((toggle) => toggle.setValue(this.plugin.settings.showChangelogOnUpdate).onChange((value) => {
      void (async () => {
        this.plugin.settings.showChangelogOnUpdate = value;
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian10.Setting(containerEl).setName("View changelog").setDesc("Browse recent changes and complete release history starting from v2.0.0.").addButton((button) => button.setButtonText("View what's new").onClick(() => {
      new ChangelogModal(this.app, this.plugin).open();
    }));
    new import_obsidian10.Setting(containerEl).setName("Help & community").setHeading();
    new import_obsidian10.Setting(containerEl).setName("Facing a problem?").setDesc("Found a bug or have a suggestion? Create an issue on GitHub to get help from the community.").addButton((button) => button.setButtonText("Report an issue").onClick(() => {
      window.open("https://github.com/racstan/obsidian-ai-scheduler/issues", "_blank");
    }));
    new import_obsidian10.Setting(containerEl).setName("About").setHeading();
    const aboutCard = containerEl.createDiv({ cls: "ai-scheduler-about-card" });
    const aboutHeader = aboutCard.createDiv({ cls: "ai-scheduler-about-header" });
    aboutHeader.createDiv({ text: "AI Scheduler for Obsidian", cls: "ai-scheduler-about-title" });
    aboutHeader.createSpan({ text: `v${this.plugin.manifest.version}`, cls: "ai-scheduler-version-badge is-latest" });
    aboutCard.createEl("p", {
      text: "The autonomous background scheduling and proactive intelligence engine for Obsidian. Turn your vault into an active thinking partner that plans, reviews, executes, and synthesizes your knowledge in the background.",
      cls: "ai-scheduler-about-desc"
    });
    const metaRow = aboutCard.createDiv({ cls: "ai-scheduler-about-meta" });
    const authorEl = metaRow.createSpan({ text: "Author: " });
    const authorLink = authorEl.createEl("a", { text: "@racstan", href: "https://github.com/racstan" });
    authorLink.target = "_blank";
    metaRow.createSpan({ text: " \xB7 " });
    metaRow.createSpan({ text: "License: PolyForm Noncommercial 1.0.0" });
    metaRow.createSpan({ text: " \xB7 " });
    const ghLink = metaRow.createEl("a", { text: "GitHub repository", href: "https://github.com/racstan/obsidian-ai-scheduler" });
    ghLink.target = "_blank";
    new import_obsidian10.Setting(containerEl).setName("Documentation & source code").setDesc("Read the setup guide, contribute, or star the project on GitHub.").addButton((button) => button.setButtonText("View on GitHub").onClick(() => {
      window.open("https://github.com/racstan/obsidian-ai-scheduler", "_blank");
    }));
  }
};

// src/notes.ts
var import_obsidian11 = require("obsidian");
var TABLE_START = "<!-- ai-scheduler:table:start -->";
var TABLE_END = "<!-- ai-scheduler:table:end -->";
function slugify(title) {
  const slug = String(title || "task").toLowerCase().replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/\s/g, "-");
  return slug.slice(0, 80) || "task";
}
var ScheduleNotesSync = class _ScheduleNotesSync {
  constructor(plugin) {
    this.lastWritten = /* @__PURE__ */ new Map();
    this.syncing = false;
    this.debounceTimer = null;
    this.plugin = plugin;
  }
  get folder() {
    return (0, import_obsidian11.normalizePath)(this.plugin.settings.scheduleFolder || "AI Schedules");
  }
  static isInside(folder, path) {
    return path === folder || path.startsWith(`${folder}/`);
  }
  notePathFor(job) {
    if (job.notePath && _ScheduleNotesSync.isInside(this.folder, job.notePath)) {
      return job.notePath;
    }
    const claimed = new Set(this.plugin.jobs.map((other) => other.id !== job.id ? other.notePath : null).filter(Boolean));
    const base = `${String(job.taskNumber || "").padStart(2, "0")}-${slugify(job.title)}`;
    let candidate = (0, import_obsidian11.normalizePath)(`${this.folder}/${base}.md`);
    let suffix = 2;
    while (claimed.has(candidate)) {
      candidate = (0, import_obsidian11.normalizePath)(`${this.folder}/${base}-${suffix}.md`);
      suffix += 1;
    }
    if (job.notePath && !_ScheduleNotesSync.isInside(this.folder, job.notePath)) {
      const oldFile = this.plugin.app.vault.getAbstractFileByPath(job.notePath);
      if (oldFile instanceof import_obsidian11.TFile) {
        try {
          void this.plugin.app.fileManager.renameFile(oldFile, candidate);
        } catch (e) {
        }
      }
    }
    return candidate;
  }
  forgetPath(path) {
    this.lastWritten.delete(path);
  }
  definitionFor(job) {
    const schedule = { kind: job.schedule.kind };
    if (job.schedule.at) schedule.at = job.schedule.at;
    if (job.schedule.time) schedule.time = job.schedule.time;
    if (job.schedule.days) schedule.days = job.schedule.days;
    if (job.schedule.rules) schedule.rules = job.schedule.rules;
    if (job.schedule.event) schedule.event = job.schedule.event;
    if (job.schedule.intervalMinutes) schedule.intervalMinutes = job.schedule.intervalMinutes;
    if (job.schedule.maxIterations) schedule.maxIterations = job.schedule.maxIterations;
    if (job.schedule.expression) schedule.expression = job.schedule.expression;
    const definition = {
      id: job.id,
      taskNumber: job.taskNumber,
      title: job.title,
      prompt: job.prompt,
      enabled: job.enabled,
      notify: job.notify,
      schedule,
      output: job.output || null,
      contextPaths: job.contextPaths || [],
      routine: job.routine
    };
    if (job.cooldownMinutes !== void 0) definition.cooldownMinutes = job.cooldownMinutes;
    return definition;
  }
  tableSection(job) {
    const cronForm = cronFormFor(job.schedule);
    const runs = previewSchedule(job.schedule, 3);
    const lines = [
      TABLE_START,
      "## Schedule",
      "",
      "| | |",
      "| --- | --- |",
      `| Kind | \`${job.schedule.kind}\` |`,
      `| Cron form | ${cronForm ? `\`${cronForm}\`` : "\u2014"} |`,
      `| Meaning | ${describeSchedule(job)} |`,
      "",
      "**Next runs**",
      "",
      ...runs.length ? runs.map((run, index) => `${index + 1}. ${run}`) : ["None scheduled"],
      TABLE_END
    ];
    return lines.join("\n");
  }
  renderNote(job) {
    const frontmatter = (0, import_obsidian11.stringifyYaml)({ "ai-scheduler": this.definitionFor(job) });
    const body = [
      `# #${job.taskNumber} \xB7 ${job.title}`,
      "",
      job.prompt,
      "",
      this.tableSection(job),
      "",
      "Edit the frontmatter above (or use the AI Scheduler dashboard) to change this task; the schedule table updates automatically.",
      ""
    ];
    return `---
${frontmatter.replace(/\n+$/, "")}
---
${body.join("\n")}`;
  }
  async writeFile(path, content) {
    this.plugin.markSelfWrite(path);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian11.TFile) {
      const current = await this.plugin.app.vault.read(existing);
      if (current === content) {
        this.lastWritten.set(path, content);
        return;
      }
      await this.plugin.app.vault.modify(existing, content);
    } else {
      await this.plugin.app.vault.create(path, content);
    }
    this.lastWritten.set(path, content);
  }
  /** Creates/updates the note for one job. */
  async writeNoteFor(job) {
    if (!this.plugin.settings.scheduleNotesEnabled) return;
    await this.plugin.ensureFolder(this.folder);
    const path = this.notePathFor(job);
    job.notePath = path;
    await this.writeFile(path, this.renderNote(job));
  }
  async importNote(file) {
    var _a;
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const definition = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a["ai-scheduler"];
    if (!definition || typeof definition !== "object") return false;
    const scheduleRaw = definition.schedule;
    if (!scheduleRaw || !SCHEDULE_KINDS.includes(String(scheduleRaw.kind))) return false;
    if (!String(definition.prompt || "").trim()) return false;
    const schedule = scheduleRaw;
    const existing = this.plugin.jobs.find((job2) => job2.id === definition.id);
    if (existing) {
      this.applyDefinition(existing, definition, file.path);
      return true;
    }
    const job = normalizeJob({
      title: String(definition.title || file.basename),
      prompt: String(definition.prompt),
      enabled: definition.enabled !== false,
      notify: definition.notify !== false,
      schedule,
      contextPaths: Array.isArray(definition.contextPaths) ? definition.contextPaths : [],
      output: definition.output || null,
      routine: definition.routine || null,
      cooldownMinutes: definition.cooldownMinutes,
      notePath: file.path
    });
    if (job.schedule.kind !== "event" && !job.nextRunAt) return false;
    this.plugin.jobs.push(job);
    this.plugin.assignTaskNumbers();
    return true;
  }
  /** Applies a note-edited definition to a job without forcing it enabled. */
  applyDefinition(job, definition, notePath) {
    if (definition.title) job.title = String(definition.title);
    if (typeof definition.prompt === "string") job.prompt = definition.prompt;
    if (typeof definition.enabled === "boolean") job.enabled = definition.enabled;
    if (typeof definition.notify === "boolean") job.notify = definition.notify;
    if (Array.isArray(definition.contextPaths)) job.contextPaths = definition.contextPaths.map(String);
    if (definition.output === null || typeof definition.output === "object") job.output = definition.output || null;
    if (definition.schedule && SCHEDULE_KINDS.includes(String(definition.schedule.kind))) {
      const normalized = normalizeJob({ id: job.id, schedule: definition.schedule }).schedule;
      job.schedule = normalized;
      job.nextRunAt = job.schedule.kind === "event" ? null : getScheduleNextRun(job.schedule, /* @__PURE__ */ new Date());
    }
    if (typeof definition.cooldownMinutes === "number") job.cooldownMinutes = definition.cooldownMinutes;
    job.notePath = notePath;
    if (job.enabled && job.status !== "scheduled" && job.status !== "running") {
      job.status = "scheduled";
      job.lastStatus = null;
    }
  }
  /** Imports stray definition notes, then writes a note for every job. Returns notes written. */
  async syncAll() {
    if (!this.plugin.settings.scheduleNotesEnabled || this.syncing) return 0;
    this.syncing = true;
    let written = 0;
    try {
      await this.plugin.ensureFolder(this.folder);
      const folder = this.plugin.app.vault.getAbstractFileByPath(this.folder);
      if (folder && "children" in folder) {
        for (const child of folder.children) {
          if (!(child instanceof import_obsidian11.TFile) || child.extension !== "md") continue;
          if (!this.plugin.app.vault.getAbstractFileByPath(child.path)) continue;
          const tracked = this.plugin.jobs.some((job) => job.notePath === child.path);
          if (tracked) continue;
          if (await this.importNote(child)) written += 1;
        }
      }
      if (written) await this.plugin.saveState();
      for (const job of [...this.plugin.jobs]) {
        const path = this.notePathFor(job);
        const content = this.renderNote(job);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (existing instanceof import_obsidian11.TFile) {
          const current = await this.plugin.app.vault.read(existing);
          if (current !== content) {
            await this.writeFile(path, content);
            written += 1;
          } else {
            this.lastWritten.set(path, content);
          }
        } else {
          await this.writeFile(path, content);
          written += 1;
        }
        job.notePath = path;
      }
      if (written) await this.plugin.saveState();
    } finally {
      this.syncing = false;
    }
    return written;
  }
  /** Debounced post-save hook; skips while the syncer itself is writing. */
  requestSync() {
    if (!this.plugin.settings.scheduleNotesEnabled) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncAll().catch((error) => {
        console.error("[ai-scheduler] schedule note sync failed:", error);
      });
    }, 600);
  }
  /** Vault watcher for edits, deletions, and renames inside the folder. */
  async handleVaultChange(file, eventType, oldPath) {
    var _a;
    if (!this.plugin.settings.scheduleNotesEnabled || this.syncing) return;
    if (!file || !file.path) return;
    const folder = this.folder;
    const watchPath = eventType === "rename" ? oldPath || file.path : file.path;
    if (!_ScheduleNotesSync.isInside(folder, watchPath) && !_ScheduleNotesSync.isInside(folder, file.path)) return;
    if (eventType === "rename") {
      const job2 = this.plugin.jobs.find((candidate) => candidate.notePath === oldPath);
      if (job2 && _ScheduleNotesSync.isInside(folder, file.path) && file instanceof import_obsidian11.TFile) {
        job2.notePath = file.path;
        this.lastWritten.delete(oldPath || "");
        await this.plugin.saveState();
      }
      return;
    }
    if (eventType === "delete") {
      const job2 = this.plugin.jobs.find((candidate) => candidate.notePath === watchPath);
      if (job2) {
        job2.notePath = null;
        await this.plugin.deleteJob(job2);
      }
      this.lastWritten.delete(watchPath);
      return;
    }
    if (!(file instanceof import_obsidian11.TFile) || file.extension !== "md") return;
    const content = await this.plugin.app.vault.read(file);
    if (this.lastWritten.get(file.path) === content) return;
    this.lastWritten.set(file.path, content);
    const job = this.plugin.jobs.find((candidate) => candidate.notePath === file.path);
    if (job) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const definition = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a["ai-scheduler"];
      if (definition && typeof definition === "object") {
        this.applyDefinition(job, definition, file.path);
        await this.plugin.saveState();
      }
    } else {
      await this.syncAll();
    }
  }
};

// src/main.ts
var TICK_MS = 15e3;
var AISchedulerPlugin = class extends import_obsidian12.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.jobs = [];
    this.deletedJobs = [];
    this.activity = [];
    this.running = false;
    this.reviewRunning = false;
    this.lastTickError = null;
    this.notesSync = new ScheduleNotesSync(this);
    this.pendingVaultEvents = [];
    this.runningJobs = /* @__PURE__ */ new Set();
    this.isPlanning = false;
    this.activePlanningGoal = null;
    this.selfWrites = /* @__PURE__ */ new Set();
    this.statusBarEl = null;
    this.statusBarTimer = null;
  }
  markSelfWrite(path) {
    const norm = (0, import_obsidian12.normalizePath)(path);
    this.selfWrites.add(norm);
    window.setTimeout(() => {
      this.selfWrites.delete(norm);
    }, 3e3);
  }
  async onload() {
    const data = await this.loadData();
    const parsed = parseStoredData(data);
    this.settings = parsed.settings;
    this.jobs = parsed.jobs;
    this.deletedJobs = parsed.deletedJobs;
    this.activity = parsed.activity;
    recoverInterruptedRuns(this.jobs);
    this.assignTaskNumbers();
    this.running = false;
    this.reviewRunning = false;
    this.lastTickError = null;
    if (typeof this.addStatusBarItem === "function") {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass("ai-scheduler-status-bar");
      this.statusBarEl.hide();
      this.updateStatusBar();
    }
    this.addRibbonIcon("brain", "Open AI Scheduler", () => new AssistantModal(this.app, this).open());
    this.addCommand({
      id: "open-assistant",
      name: "Open assistant dashboard",
      callback: () => new AssistantModal(this.app, this).open()
    });
    this.addCommand({
      id: "open-calendar",
      name: "Open schedule calendar",
      callback: () => new CalendarModal(this.app, this).open()
    });
    this.addCommand({
      id: "plan-with-ai",
      name: "Ask AI to plan a schedule",
      callback: () => new PlannerModal(this.app, this).open()
    });
    this.addCommand({
      id: "run-daily-review",
      name: "Run AI daily preview",
      callback: () => this.startReviewRun(true, "daily")
    });
    this.addCommand({
      id: "run-nightly-review",
      name: "Run AI nightly review now",
      callback: () => this.startReviewRun(true, "nightly")
    });
    this.addCommand({
      id: "enable-nightly-review",
      name: "Enable nightly AI review",
      callback: async () => {
        this.settings.nightlyReviewEnabled = true;
        await this.ensureNightlyReviewJob();
        await this.saveState();
        new import_obsidian12.Notice("Nightly AI review enabled");
      }
    });
    this.addCommand({
      id: "disable-nightly-review",
      name: "Disable nightly AI review",
      callback: async () => {
        this.settings.nightlyReviewEnabled = false;
        await this.ensureNightlyReviewJob();
        await this.saveState();
        new import_obsidian12.Notice("Nightly AI review disabled");
      }
    });
    this.addCommand({
      id: "toggle-nightly-review",
      name: "Toggle nightly AI review",
      callback: async () => {
        this.settings.nightlyReviewEnabled = !this.settings.nightlyReviewEnabled;
        await this.ensureNightlyReviewJob();
        await this.saveState();
        new import_obsidian12.Notice(this.settings.nightlyReviewEnabled ? "Nightly AI review enabled" : "Nightly AI review disabled");
      }
    });
    this.addCommand({
      id: "enable-all-jobs",
      name: "Enable all scheduled tasks",
      callback: async () => {
        const userTasks = this.jobs.filter((j) => !isNightlyReviewJob(j));
        if (userTasks.length === 0) {
          new import_obsidian12.Notice("No tasks available.");
          return;
        }
        const count = await this.enableAllJobs();
        new import_obsidian12.Notice(count > 0 ? `${count} scheduled task(s) enabled.` : "All scheduled tasks are already enabled.");
      }
    });
    this.addCommand({
      id: "disable-all-jobs",
      name: "Disable all scheduled tasks",
      callback: async () => {
        const userTasks = this.jobs.filter((j) => !isNightlyReviewJob(j));
        if (userTasks.length === 0) {
          new import_obsidian12.Notice("No tasks available.");
          return;
        }
        const count = await this.disableAllJobs();
        new import_obsidian12.Notice(count > 0 ? `${count} scheduled task(s) disabled.` : "All scheduled tasks are already disabled.");
      }
    });
    this.addCommand({
      id: "restore-last-deleted-task",
      name: "Restore last deleted task",
      callback: async () => {
        const restored = await this.restoreLastDeletedJob();
        if (restored) {
          new import_obsidian12.Notice(`Restored task #${restored.taskNumber}: ${restored.title}`);
        } else {
          new import_obsidian12.Notice("No deleted tasks to restore.");
        }
      }
    });
    this.addCommand({
      id: "sync-schedule-notes",
      name: "Sync schedule notes now",
      callback: async () => {
        if (!this.settings.scheduleNotesEnabled) {
          new import_obsidian12.Notice("Schedule notes are not enabled in settings.");
          return;
        }
        try {
          const written = await this.notesSync.syncAll();
          new import_obsidian12.Notice(written ? `${written} note(s) reconciled.` : "All schedule notes are up to date.");
        } catch (error) {
          new import_obsidian12.Notice(`Could not sync schedule notes: ${errorText(error)}`, 8e3);
        }
      }
    });
    this.addCommand({
      id: "view-changelog",
      name: "View changelog / what's new",
      callback: () => new ChangelogModal(this.app, this).open()
    });
    this.addSettingTab(new AssistantSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => {
      void this.tick();
    }, TICK_MS));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      void this.handleVaultChange(file);
      void this.notesSync.handleVaultChange(file, "modify");
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      void this.handleVaultChange(file);
      void this.notesSync.handleVaultChange(file, "modify");
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      void this.notesSync.handleVaultChange(file, "delete");
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.notesSync.handleVaultChange(file, "rename", oldPath);
    }));
    if (this.settings.nightlyReviewEnabled) await this.ensureNightlyReviewJob();
    await this.saveState();
    const currentVersion = this.manifest.version;
    const previousVersion = this.settings.lastSeenVersion;
    this.settings.lastSeenVersion = currentVersion;
    await this.saveState();
    if (this.settings.showChangelogOnUpdate && previousVersion && previousVersion !== currentVersion) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          new ChangelogModal(this.app, this, {
            fromVersion: previousVersion,
            currentVersion,
            isAutomatic: true
          }).open();
        }, 600);
      });
    }
    await this.catchUpOnStart();
    if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
  }
  onunload() {
    var _a;
    if (this.statusBarTimer !== null) {
      window.clearInterval(this.statusBarTimer);
      this.statusBarTimer = null;
    }
    (_a = this.statusBarEl) == null ? void 0 : _a.remove();
    this.statusBarEl = null;
  }
  async saveState() {
    try {
      await this.saveData({
        version: 6,
        settings: this.settings,
        jobs: this.jobs,
        deletedJobs: this.deletedJobs.slice(0, 100),
        activity: this.activity.slice(-50)
      });
    } catch (error) {
      console.error("[ai-scheduler] Failed to save state:", error);
    }
    this.notesSync.requestSync();
  }
  assignTaskNumbers() {
    const used = /* @__PURE__ */ new Set();
    let next = 1;
    for (const job of this.jobs) {
      const existing = Number(job.taskNumber);
      if (Number.isInteger(existing) && existing > 0 && !used.has(existing)) {
        used.add(existing);
        next = Math.max(next, existing + 1);
        job.taskNumber = existing;
        continue;
      }
      while (used.has(next)) next += 1;
      job.taskNumber = next;
      used.add(next);
      next += 1;
    }
    for (const job of this.jobs) {
      if (!isNightlyReviewJob(job) && !job.enabled && job.status === "scheduled") {
        job.status = "disabled";
        job.lastStatus = "disabled";
      }
    }
  }
  logActivity(type, message, jobId = null) {
    logActivityEntry(this.activity, type, message, jobId);
  }
  async clearActivity() {
    this.activity = [];
    await this.saveState();
  }
  async catchUpOnStart() {
    const now = Date.now();
    const plan = planStartupCatchUp(this.jobs, this.settings, now);
    for (const job of plan.stale) skipMissedJob(job);
    if (!this.settings.catchUpOnStart) {
      if (plan.stale.length) await this.saveState();
      return;
    }
    if (plan.missed.length || plan.stale.length) {
      if (plan.missed.length) {
        this.logActivity("startup", `Found ${plan.missed.length} task(s) due while Obsidian was closed`);
      }
      await this.saveState();
    }
    if (plan.missed.length) {
      new import_obsidian12.Notice(`${plan.missed.length} AI task(s) are ready after startup`, 6e3);
    }
    await sleep(1e3);
    await this.tick();
  }
  async tick() {
    if (this.running) return;
    const due = dueJobs(this.jobs, Date.now());
    if (!due.length) {
      if (this.pendingVaultEvents.length) {
        const events = this.pendingVaultEvents.splice(0);
        for (const path of events) await this.handleVaultChange({ path });
      }
      return;
    }
    this.running = true;
    try {
      for (const job of due) {
        if (this.runningJobs.has(job.id)) continue;
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
    }
    if (this.pendingVaultEvents.length) {
      const events = this.pendingVaultEvents.splice(0);
      for (const path of events) await this.handleVaultChange({ path });
    }
  }
  async executeJob(job) {
    if (this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id);
    this.updateStatusBar();
    try {
      await this.runJobBody(job);
    } finally {
      this.runningJobs.delete(job.id);
      this.updateStatusBar();
    }
  }
  async runJobBody(job) {
    var _a, _b, _c;
    job.status = "running";
    job.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
    job.attempts = Number(job.attempts || 0) + 1;
    this.logActivity("running", `Task #${job.taskNumber} started: ${job.title}`, job.id);
    if (job.notify !== false) {
      new import_obsidian12.Notice(`AI Scheduler: Task #${job.taskNumber} started (${job.title})...`, 4e3);
    }
    this.updateStatusBar();
    await this.saveState();
    try {
      const execution = await resolveJobExecution(this, job);
      Object.assign(job, {
        profile: execution.modelRef || null,
        tab: execution.tab,
        conversationId: execution.conversationId,
        providerId: execution.providerId,
        model: execution.model
      });
      await this.saveState();
      const context = this.getJobContext(job);
      const prompt = job.routine === "daily-review" ? "" : executionPrompt(job.prompt, context.paths);
      const reply = job.routine === "daily-review" ? await this.runDailyReview(false, execution, "nightly") : await sendToAI(this, prompt, execution, context);
      const trimmedReply = (reply || "").trim();
      if (!trimmedReply) {
        throw new Error("The AI returned an empty response.");
      }
      job.lastReply = reply || "";
      job.lastStatus = "completed";
      job.lastError = null;
      job.status = "completed";
      job.runCount = Number(job.runCount || 0) + 1;
      await this.processFollowUps(reply, job);
      if (((_a = job.output) == null ? void 0 : _a.folder) && reply) {
        const writtenPath = await this.writeOutput(job.output.folder, job.output.filename, reply);
        job.lastOutputPath = writtenPath;
        if (!job.lastOutputFiles) job.lastOutputFiles = [];
        if (!job.lastOutputFiles.includes(writtenPath)) {
          job.lastOutputFiles.push(writtenPath);
        }
      } else if (reply) {
        const fallbackFolder = this.getDefaultOutputFolder();
        const writtenPath = await this.writeOutput(fallbackFolder, (_b = job.output) == null ? void 0 : _b.filename, reply);
        job.lastOutputPath = writtenPath;
        if (!job.lastOutputFiles) job.lastOutputFiles = [];
        if (!job.lastOutputFiles.includes(writtenPath)) {
          job.lastOutputFiles.push(writtenPath);
        }
      }
      reconcileAfterRun(job);
      this.logActivity("completed", `Task #${job.taskNumber} finished: ${job.title}`, job.id);
      await this.appendTaskLogRow(job, "completed", (_c = job.lastOutputFiles) != null ? _c : []);
      if (this.settings.notifyOnCompletion && job.notify !== false) {
        new import_obsidian12.Notice(`AI completed: ${job.title}`, 5e3);
      }
      if (this.settings.systemNotifications && job.notify !== false) {
        sendSystemNotification("AI Scheduler", `AI completed: ${job.title}`);
      }
    } catch (error) {
      job.status = "failed";
      job.lastStatus = "failed";
      job.lastError = errorText(error);
      reconcileAfterRun(job, { failed: true });
      this.lastTickError = job.lastError;
      this.logActivity("failed", `Task #${job.taskNumber} failed: ${job.title} (${job.lastError})`, job.id);
      await this.appendTaskLogRow(job, "failed", []);
      new import_obsidian12.Notice(`AI task failed: ${job.title}
${job.lastError}`, 8e3);
      if (this.settings.systemNotifications) {
        sendSystemNotification("AI Scheduler", `AI task failed: ${job.title}`);
      }
    }
    await this.saveState();
  }
  async handleVaultChange(file) {
    if (!file || !file.path) return;
    const normPath = (0, import_obsidian12.normalizePath)(file.path);
    if (this.selfWrites.has(normPath)) return;
    const normReport = (0, import_obsidian12.normalizePath)(this.settings.reportFolder || "AI Reviews");
    const normSchedule = (0, import_obsidian12.normalizePath)(this.settings.scheduleFolder || "AI Schedules");
    if (ScheduleNotesSync.isInside(normReport, normPath) || ScheduleNotesSync.isInside(normSchedule, normPath)) {
      return;
    }
    if (this.running) {
      this.pendingVaultEvents.push(file.path);
      return;
    }
    const eventJobs = this.jobs.filter((job) => job.enabled && job.schedule && job.schedule.kind === "event" && (!job.schedule.event || job.schedule.event === "modify" || job.schedule.event === "vault-change"));
    if (!eventJobs.length) return;
    const now = Date.now();
    for (const job of eventJobs) {
      const cooldown = Math.max(0, Number(job.cooldownMinutes) || 10) * 6e4;
      if (job.lastRunAt && now - new Date(job.lastRunAt).getTime() < cooldown) continue;
      job.nextRunAt = new Date(now + 2e3).toISOString();
      job.lastEventPath = file.path;
    }
    await this.saveState();
  }
  async addJob(raw) {
    const job = normalizeJob(raw);
    if (job.schedule.kind !== "event" && !job.nextRunAt) {
      throw new Error(`Cannot create "${job.title}": its schedule is invalid or has no valid time.`);
    }
    this.assignTaskNumbers();
    job.taskNumber = Math.max(0, ...this.jobs.map((candidate) => Number(candidate.taskNumber) || 0)) + 1;
    this.jobs.push(job);
    await this.saveState();
    return job;
  }
  async ensureNightlyReviewJob() {
    let job = this.jobs.find((candidate) => candidate.routine === "daily-review");
    if (!this.settings.nightlyReviewEnabled) {
      if (job) {
        job.enabled = false;
        job.nextRunAt = null;
        job.status = "disabled";
        job.lastStatus = "disabled";
      }
      return;
    }
    if (!validClock(this.settings.reviewTime)) {
      new import_obsidian12.Notice("AI Scheduler: review time is invalid, nightly review not scheduled.");
      return;
    }
    if (!job) {
      job = normalizeJob({
        id: "nightly-daily-review",
        title: "Nightly daily review",
        prompt: "",
        tab: this.settings.assistantTab,
        routine: "daily-review",
        schedule: { kind: "daily", time: this.settings.reviewTime },
        notify: true
      });
      this.jobs.push(job);
    } else {
      job.enabled = true;
      job.status = "scheduled";
      job.lastStatus = null;
      job.tab = this.settings.assistantTab;
      job.schedule = { kind: "daily", time: this.settings.reviewTime };
      job.nextRunAt = nextDailyRun(this.settings.reviewTime);
    }
  }
  async startReviewRun(manual = true, kind = "daily") {
    if (this.reviewRunning) {
      new import_obsidian12.Notice("A review is already running. You can keep using Obsidian while it finishes.", 5e3);
      return;
    }
    new import_obsidian12.Notice(`${kind === "nightly" ? "Nightly" : "Daily"} review started. It will create ${this.settings.reportFolder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7e3);
    void this.runDailyReview(manual, null, kind).catch((error) => {
      this.logActivity("failed", `Review failed: ${errorText(error)}`);
      new import_obsidian12.Notice(`Review failed: ${errorText(error)}`, 8e3);
      void this.saveState();
    });
  }
  async runDailyReview(manual, execution = null, kind = "daily") {
    if (this.reviewRunning) {
      throw new Error("A review is already in progress.");
    }
    this.reviewRunning = true;
    this.updateStatusBar();
    try {
      const now = /* @__PURE__ */ new Date();
      const today = localDateKey(now);
      const start = /* @__PURE__ */ new Date();
      start.setHours(0, 0, 0, 0);
      const files = this.app.vault.getMarkdownFiles().filter((file) => this.includeReviewFile(file, start)).sort((a, b) => b.stat.mtime - a.stat.mtime);
      const fileList = files.length ? files.map((file) => `- ${file.path}`).join("\n") : "- No Markdown files were created or modified today.";
      const prompt = reviewPrompt(kind, today, fileList);
      const nightlyJob = this.jobs.find((candidate) => candidate.routine === "daily-review");
      const model = kind === "nightly" ? this.settings.nightlyReviewModel : this.settings.dailyReviewModel;
      const resolved = execution || (nightlyJob && kind === "nightly" ? await resolveJobExecution(this, nightlyJob) : await resolveModel(this, model, kind === "nightly" ? "nightly review" : "daily preview"));
      const context = getPathsContext(this.app, files.map((file) => file.path));
      const reply = await sendToAI(this, prompt, resolved, context);
      const reportTitle = kind === "nightly" ? "Nightly Review" : "Daily Preview";
      const report = reply || `# ${reportTitle} - ${today}

The active AI backend did not return a report.`;
      const timestamp = localTimestampKey(now);
      let filename = `${timestamp}.md`;
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath((0, import_obsidian12.normalizePath)(`${this.settings.reportFolder}/${filename}`))) {
        filename = `${timestamp}-${suffix}.md`;
        suffix += 1;
      }
      const path = `${this.settings.reportFolder}/${filename}`;
      await this.writeOutput(this.settings.reportFolder, filename, `# ${reportTitle} - ${today}

Generated: ${formatDate(now.toISOString())}

${report}`);
      if (nightlyJob) {
        nightlyJob.lastOutputPath = path;
        if (!nightlyJob.lastOutputFiles) nightlyJob.lastOutputFiles = [];
        if (!nightlyJob.lastOutputFiles.includes(path)) {
          nightlyJob.lastOutputFiles.push(path);
        }
      }
      this.logActivity("review", `Daily review written to ${path}`);
      if (manual || this.settings.notifyOnCompletion) {
        new import_obsidian12.Notice(`Review written to ${path}`, 6e3);
      }
      if (this.settings.systemNotifications) {
        sendSystemNotification("AI Scheduler", `Review written to ${path}`);
      }
      await this.saveState();
      return report;
    } finally {
      this.reviewRunning = false;
      this.updateStatusBar();
    }
  }
  includeReviewFile(file, start) {
    if (!file || !file.path) return false;
    const normPath = (0, import_obsidian12.normalizePath)(file.path);
    const normReport = (0, import_obsidian12.normalizePath)(this.settings.reportFolder || "AI Reviews");
    const normSchedule = (0, import_obsidian12.normalizePath)(this.settings.scheduleFolder || "AI Schedules");
    if (ScheduleNotesSync.isInside(normReport, normPath) || ScheduleNotesSync.isInside(normSchedule, normPath)) {
      return false;
    }
    if (this.settings.reviewContextMode === "all-markdown") return true;
    if (this.settings.reviewContextMode === "no-files") return false;
    return Boolean(file.stat && file.stat.mtime >= start.getTime());
  }
  getVaultContextOptions() {
    return getVaultContextOptions(this.app);
  }
  getPathsContext(paths) {
    return getPathsContext(this.app, paths);
  }
  validateContextPaths(paths) {
    if (!Array.isArray(paths)) return [];
    const available = this.getVaultContextOptions();
    const known = new Set(available.map((option) => option.path));
    return paths.filter((path) => known.has(path));
  }
  getJobContext(job) {
    const context = getPathsContext(this.app, job && job.contextPaths);
    if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(", ")}`);
    return context;
  }
  async writeOutput(folder, filename, content) {
    const cleanFolder = (0, import_obsidian12.normalizePath)(String(folder || "").replace(/^\/+|\/+$/g, ""));
    let cleanName = String(filename || `${localDateKey()}.md`).replace(/[\\/]/g, "-");
    let path = (0, import_obsidian12.normalizePath)(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
    this.markSelfWrite(path);
    await this.ensureFolder(cleanFolder);
    let existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian12.TFolder) {
      let suffix = 2;
      while (existing instanceof import_obsidian12.TFolder) {
        cleanName = cleanName.replace(/(\.md)?$/, `-${suffix}.md`);
        path = (0, import_obsidian12.normalizePath)(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
        existing = this.app.vault.getAbstractFileByPath(path);
        suffix += 1;
      }
    }
    if (existing instanceof import_obsidian12.TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      try {
        await this.app.vault.create(path, content);
      } catch (err) {
        const retryFile = this.app.vault.getAbstractFileByPath(path);
        if (retryFile instanceof import_obsidian12.TFile) {
          await this.app.vault.modify(retryFile, content);
        } else if (errorText(err).includes("already exists")) {
          try {
            await this.app.vault.adapter.write(path, content);
          } catch (e) {
          }
        } else {
          throw err;
        }
      }
    }
    return path;
  }
  async ensureFolder(folder) {
    if (!folder) return;
    const parts = folder.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
        }
      }
    }
  }
  /** Returns the configured default output folder, falling back to 'AI Scheduler'. */
  getDefaultOutputFolder() {
    return (this.settings.defaultOutputFolder || "").trim() || "AI Scheduler";
  }
  /** Returns the configured task log folder, falling back to the default output folder. */
  getTaskLogFolder() {
    return (this.settings.taskLogFolder || "").trim() || this.getDefaultOutputFolder();
  }
  /**
   * Appends a single row to the task activity log Markdown table.
   * The file is created on first write; subsequent runs append a row.
   * Silently skips if task logging is disabled.
   */
  async appendTaskLogRow(job, status, outputFiles) {
    if (!this.settings.taskLoggingEnabled) return;
    try {
      const logFolder = this.getTaskLogFolder();
      const logPath = (0, import_obsidian12.normalizePath)(`${logFolder}/AI SCHEDULER LOGS.md`);
      await this.ensureFolder(logFolder);
      this.markSelfWrite(logPath);
      const existing = this.app.vault.getAbstractFileByPath(logPath);
      let serial = 1;
      let currentContent = TASK_LOG_HEADER;
      if (existing instanceof import_obsidian12.TFile) {
        const raw = await this.app.vault.read(existing);
        const dataRows = raw.split("\n").filter(
          (line) => line.startsWith("| ") && !line.startsWith("| # ") && !line.startsWith("| ---")
        );
        serial = dataRows.length + 1;
        currentContent = raw;
      }
      const row = buildTaskLogRow(serial, job, status, outputFiles);
      const newContent = existing instanceof import_obsidian12.TFile ? `${currentContent.trimEnd()}
${row}` : `${TASK_LOG_HEADER}
${row}`;
      if (existing instanceof import_obsidian12.TFile) {
        await this.app.vault.modify(existing, newContent);
      } else {
        try {
          await this.app.vault.create(logPath, newContent);
        } catch (err) {
          const retryFile = this.app.vault.getAbstractFileByPath(logPath);
          if (retryFile instanceof import_obsidian12.TFile) {
            const raw = await this.app.vault.read(retryFile);
            await this.app.vault.modify(retryFile, `${raw.trimEnd()}
${row}`);
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      console.warn("[ai-scheduler] Could not write to task log:", err);
    }
  }
  async processFollowUps(reply, parentJob) {
    const MAX_TOTAL_JOBS = 100;
    const plans = extractJson(reply).map((item) => validateJobSchema(item)).filter((item) => Boolean(item));
    for (const plan of plans.slice(0, 3)) {
      if (this.jobs.length >= MAX_TOTAL_JOBS) {
        console.warn("[ai-scheduler] Follow-up skipped: job limit reached");
        break;
      }
      await this.addJob(Object.assign(
        this.jobFromPlan(plan, parentJob.tab, "self-talk"),
        {
          profile: parentJob.profile || null,
          conversationId: parentJob.conversationId || null,
          providerId: parentJob.providerId || null,
          model: parentJob.model || null,
          contextPaths: parentJob.contextPaths || []
        }
      ));
    }
  }
  jobFromPlan(plan, fallbackTab, source) {
    const schedule = plan.schedule || {};
    const normalized = {
      kind: String(schedule.kind) || "once",
      at: schedule.at,
      time: schedule.time,
      days: schedule.days,
      rules: schedule.rules,
      intervalMinutes: schedule.intervalMinutes || schedule.everyMinutes || Number(schedule.everyHours || 0) * 60,
      maxIterations: normalizeMaxIterations(schedule.maxIterations || schedule.maxRuns || schedule.iterations),
      event: schedule.event,
      expression: schedule.expression
    };
    const planRecord = plan;
    const context = plan.context;
    const titleStr = typeof plan.title === "string" ? plan.title : "Assistant task";
    const promptCandidate = typeof plan.prompt === "string" && plan.prompt.trim() ? plan.prompt.trim() : typeof plan.instructions === "string" && plan.instructions.trim() ? plan.instructions.trim() : typeof plan.action === "string" && plan.action.trim() ? plan.action.trim() : typeof plan.task === "string" && plan.task.trim() ? plan.task.trim() : typeof plan.description === "string" && plan.description.trim() ? plan.description.trim() : titleStr;
    const doubt = typeof plan.doubt === "string" && plan.doubt.trim() ? plan.doubt.trim() : typeof plan.clarification === "string" && plan.clarification.trim() ? plan.clarification.trim() : null;
    const nextRunAt = normalized.kind === "event" ? null : getScheduleNextRun(normalized);
    if (normalized.kind !== "event" && !nextRunAt) {
      throw new Error(`Invalid schedule for "${titleStr}": no valid next run time`);
    }
    return {
      title: titleStr.slice(0, 120),
      prompt: promptCandidate,
      doubt,
      tab: Number(planRecord.tab || fallbackTab || this.settings.assistantTab),
      profile: planRecord.profile || null,
      conversationId: planRecord.conversationId || null,
      providerId: planRecord.providerId || null,
      model: planRecord.model || null,
      schedule: normalized,
      nextRunAt,
      output: planRecord.output || null,
      notify: planRecord.notify !== false,
      contextPaths: Array.isArray(planRecord.contextPaths) ? planRecord.contextPaths : Array.isArray(context == null ? void 0 : context.paths) ? context.paths : [],
      cooldownMinutes: planRecord.cooldownMinutes || schedule.cooldownMinutes,
      source
    };
  }
  async planAndCreate(goal, contextPaths = [], resultFolder = "") {
    this.isPlanning = true;
    this.activePlanningGoal = goal;
    this.updateStatusBar();
    try {
      const execution = await resolveModel(this, this.settings.planningModel, "AI planning");
      const validatedPaths = this.validateContextPaths(contextPaths);
      const prompt = plannerPrompt(goal, validatedPaths);
      const context = getPathsContext(this.app, validatedPaths);
      const reply = await sendToAI(this, prompt, execution, context);
      const plans = extractJson(reply).map((item) => validateJobSchema(item)).filter((item) => Boolean(item));
      if (!plans.length) throw new Error("The AI returned no valid schedule. Ask it for a concrete time or cadence.");
      const jobs = [];
      for (const plan of plans.slice(0, 10)) {
        const planRecord = plan;
        const newJob = await this.addJob(Object.assign(
          this.jobFromPlan(Object.assign({}, plan, {
            contextPaths: planRecord.contextPaths || planRecord.context && planRecord.context.paths || validatedPaths,
            output: planRecord.output || (resultFolder ? { folder: resultFolder } : null)
          }), execution.tab, "planner"),
          { profile: execution.modelRef, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model }
        ));
        jobs.push(newJob);
        if (newJob.doubt) {
          new import_obsidian12.Notice(`AI Planning Note: ${newJob.doubt}`, 9e3);
        }
        this.logActivity("planned", `AI created Task #${newJob.taskNumber}: ${newJob.title}${newJob.doubt ? ` (${newJob.doubt})` : ""}`, newJob.id);
      }
      await this.saveState();
      return { reply, jobs };
    } finally {
      this.isPlanning = false;
      this.activePlanningGoal = null;
      this.updateStatusBar();
    }
  }
  async refineJob(job, request, contextPaths = job.contextPaths || []) {
    const execution = await resolveModel(this, this.settings.planningModel, "AI task editing");
    const prompt = refinePrompt(job, request, contextPaths);
    const context = getPathsContext(this.app, contextPaths);
    if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(", ")}`);
    const reply = await sendToAI(this, prompt, execution, context);
    const plan = extractJson(reply)[0];
    if (!plan || !plan.title || !plan.prompt || !plan.schedule) throw new Error("The AI returned an invalid job edit.");
    return plan;
  }
  backendInfo(mode = this.settings.backendMode) {
    return BACKEND_INFO[mode === "copilot" ? "copilot" : "claudian"];
  }
  async checkBackendSetup(mode = this.settings.backendMode) {
    return checkBackendSetup(this, mode);
  }
  checkCopilotSetup() {
    return checkCopilotSetup(this);
  }
  checkClaudianSetup() {
    return checkClaudianSetup(this);
  }
  getClaudianPlugin() {
    return getClaudianPlugin(this);
  }
  getCopilotPlugin() {
    return getCopilotPlugin(this);
  }
  getModelOptions() {
    return getModelOptions(this);
  }
  async refreshModels() {
    return refreshModels(this);
  }
  openSettingsTab() {
    const appWithSetting = this.app;
    if (appWithSetting.setting && typeof appWithSetting.setting.open === "function") {
      appWithSetting.setting.open();
      if (typeof appWithSetting.setting.openTabById === "function") {
        appWithSetting.setting.openTabById(this.manifest.id);
      }
    }
  }
  getBackendReadiness() {
    const mode = this.settings.backendMode;
    if (mode === "none" || !mode) {
      return { ok: false, message: "No AI backend selected. Choose Claudian or Obsidian Copilot in AI Scheduler settings." };
    }
    if (mode === "copilot") {
      const copilot = this.getCopilotPlugin();
      if (!copilot) {
        return { ok: false, message: "Obsidian Copilot plugin is not installed or enabled." };
      }
      const check = this.checkCopilotSetup();
      if (!check.ok) {
        return { ok: false, message: check.message };
      }
      return { ok: true, message: "Obsidian Copilot is ready." };
    } else {
      const claudian = this.getClaudianPlugin();
      if (!claudian) {
        return { ok: false, message: "Claudian plugin is not installed or enabled." };
      }
      const models = this.getModelOptions();
      if (!models.length) {
        return { ok: false, message: "No Claudian models found. Open Claudian to configure providers and API keys, then refresh models in Settings." };
      }
      if (!this.settings.planningModel && !this.settings.executionModel) {
        return { ok: false, message: "No AI model selected for tasks or planning. Please choose a model in AI Scheduler settings." };
      }
      return { ok: true, message: "Claudian is ready." };
    }
  }
  testNotification() {
    new import_obsidian12.Notice("AI Scheduler notifications are working.");
    const sentSystem = sendSystemNotification("AI Scheduler", "AI Scheduler desktop notifications are working.");
    if (!sentSystem && typeof window !== "undefined" && typeof window.Notification !== "undefined" && window.Notification.permission === "denied") {
      new import_obsidian12.Notice("System desktop notifications are blocked by windows/Obsidian permissions.", 6e3);
    }
    this.logActivity("notification", "Test notification sent");
    void this.saveState();
  }
  async deleteJob(job) {
    this.jobs = this.jobs.filter((candidate) => candidate.id !== job.id);
    this.deletedJobs = [job, ...this.deletedJobs.filter((candidate) => candidate.id !== job.id)].slice(0, 100);
    if (job.notePath) {
      const file = this.app.vault.getAbstractFileByPath(job.notePath);
      if (file instanceof import_obsidian12.TFile) {
        try {
          await this.app.fileManager.trashFile(file);
        } catch (error) {
          console.error("[ai-scheduler] Failed to trash schedule note on deletion:", error);
        }
      }
      this.notesSync.forgetPath(job.notePath);
    }
    this.logActivity("deleted", `Deleted task #${job.taskNumber}: ${job.title}`, job.id);
    await this.saveState();
  }
  async restoreJob(job) {
    this.deletedJobs = this.deletedJobs.filter((candidate) => candidate.id !== job.id);
    if (!this.jobs.some((j) => j.id === job.id)) {
      job.notePath = null;
      job.lastError = null;
      if (job.enabled) {
        job.status = "scheduled";
        job.lastStatus = null;
        rescheduleEnabledJob(job);
      } else {
        job.status = "disabled";
        job.lastStatus = "disabled";
        job.nextRunAt = null;
      }
      this.jobs.push(job);
      this.assignTaskNumbers();
      this.logActivity("restored", `Restored task #${job.taskNumber}: ${job.title}`, job.id);
      await this.saveState();
    }
  }
  async restoreAllJobs() {
    const toRestore = [...this.deletedJobs];
    let count = 0;
    for (const job of toRestore) {
      if (!this.jobs.some((j) => j.id === job.id)) {
        job.notePath = null;
        job.lastError = null;
        if (job.enabled) {
          job.status = "scheduled";
          job.lastStatus = null;
          rescheduleEnabledJob(job);
        } else {
          job.status = "disabled";
          job.lastStatus = "disabled";
          job.nextRunAt = null;
        }
        this.jobs.push(job);
        count++;
      }
    }
    this.deletedJobs = [];
    if (count > 0) {
      this.assignTaskNumbers();
      this.logActivity("restored", `Restored ${count} task(s) from trash`);
      await this.saveState();
    }
    return count;
  }
  async permanentlyDeleteJob(job) {
    this.deletedJobs = this.deletedJobs.filter((candidate) => candidate.id !== job.id);
    this.logActivity("deleted", `Permanently removed task #${job.taskNumber}: ${job.title}`, job.id);
    await this.saveState();
  }
  async emptyTrash() {
    const count = this.deletedJobs.length;
    this.deletedJobs = [];
    if (count > 0) {
      this.logActivity("deleted", `Emptied trash (${count} task(s) permanently removed)`);
      await this.saveState();
    }
    return count;
  }
  async restoreLastDeletedJob() {
    if (this.deletedJobs.length === 0) return null;
    const job = this.deletedJobs[0];
    await this.restoreJob(job);
    return job;
  }
  async disableAllJobs() {
    let count = 0;
    for (const job of this.jobs.filter((candidate) => !isNightlyReviewJob(candidate) && candidate.enabled)) {
      job.enabled = false;
      job.nextRunAt = null;
      job.status = "disabled";
      job.lastStatus = "disabled";
      count++;
    }
    if (count > 0) {
      this.logActivity("status", `Disabled ${count} scheduled task(s)`);
      await this.saveState();
    }
    return count;
  }
  async enableJob(job) {
    job.enabled = true;
    job.status = "scheduled";
    job.lastStatus = null;
    job.lastError = null;
    rescheduleEnabledJob(job);
    await this.saveState();
  }
  async enableAllJobs() {
    let count = 0;
    for (const job of this.jobs.filter((candidate) => !isNightlyReviewJob(candidate) && isDisabledTask(candidate))) {
      job.enabled = true;
      job.status = "scheduled";
      job.lastStatus = null;
      job.lastError = null;
      rescheduleEnabledJob(job);
      count++;
    }
    if (count > 0) {
      this.logActivity("status", `Enabled ${count} scheduled task(s)`);
      await this.saveState();
    }
    return count;
  }
  async deleteAllJobs() {
    const toDelete = this.jobs.filter((job) => !isNightlyReviewJob(job));
    for (const job of toDelete) {
      if (job.notePath) {
        const file = this.app.vault.getAbstractFileByPath(job.notePath);
        if (file instanceof import_obsidian12.TFile) {
          try {
            await this.app.fileManager.trashFile(file);
          } catch (error) {
            console.error("[ai-scheduler] Failed to trash schedule note on deletion:", error);
          }
        }
        this.notesSync.forgetPath(job.notePath);
      }
    }
    this.jobs = this.jobs.filter((job) => isNightlyReviewJob(job));
    if (toDelete.length > 0) {
      this.deletedJobs = [...toDelete.slice().reverse(), ...this.deletedJobs].slice(0, 100);
      this.logActivity("deleted", `Deleted ${toDelete.length} scheduled task(s)`);
      await this.saveState();
    }
    return toDelete.length;
  }
  async updateJob(job, changes) {
    Object.assign(job, changes);
    job.schedule = Object.assign({}, job.schedule, changes.schedule || {});
    job.schedule.maxIterations = normalizeMaxIterations(job.schedule.maxIterations);
    job.nextRunAt = job.schedule.kind === "event" ? null : getScheduleNextRun(job.schedule, new Date(Date.now() - 1e3));
    job.enabled = true;
    job.status = "scheduled";
    job.lastError = null;
    await this.saveState();
  }
  async retryJob(job) {
    job.enabled = true;
    job.status = "scheduled";
    job.lastStatus = null;
    job.lastError = null;
    rescheduleEnabledJob(job);
    await this.saveState();
    await this.tick();
  }
  async runJobNow(job) {
    job.enabled = true;
    job.status = "scheduled";
    job.lastStatus = null;
    job.lastError = null;
    job.nextRunAt = new Date(Date.now() - 1e3).toISOString();
    await this.saveState();
    await this.tick();
  }
  async resetRunningJob(job) {
    this.runningJobs.delete(job.id);
    job.status = "failed";
    job.lastStatus = "cancelled";
    job.lastError = "Cancelled or reset by user";
    reconcileAfterRun(job, { failed: true });
    this.logActivity("cancelled", `Task #${job.taskNumber} cancelled/reset by user: ${job.title}`, job.id);
    this.updateStatusBar();
    await this.saveState();
  }
  updateStatusBar() {
    if (!this.statusBarEl) return;
    const runningList = this.jobs.filter((job) => this.runningJobs.has(job.id) || job.status === "running");
    if (runningList.length === 0 && !this.reviewRunning && !this.isPlanning) {
      if (this.statusBarTimer !== null) {
        window.clearInterval(this.statusBarTimer);
        this.statusBarTimer = null;
      }
      this.statusBarEl.empty();
      this.statusBarEl.hide();
      return;
    }
    this.statusBarEl.show();
    this.statusBarEl.empty();
    this.statusBarEl.createSpan({ cls: "ai-scheduler-spinner-tiny ai-scheduler-status-bar-spinner" });
    const label = this.statusBarEl.createSpan({ cls: "ai-scheduler-status-bar-text" });
    if (this.isPlanning) {
      label.setText("AI: Designing schedule plan...");
    } else if (runningList.length === 1) {
      const j = runningList[0];
      const startIso = j.lastRunAt || j.nextRunAt || (/* @__PURE__ */ new Date()).toISOString();
      const duration = formatDuration(startIso);
      label.setText(`AI: #${j.taskNumber} (${j.title}) \xB7 ${duration}`);
    } else if (runningList.length > 1) {
      label.setText(`AI: ${runningList.length} tasks running...`);
    } else if (this.reviewRunning) {
      label.setText("AI: Review in progress...");
    }
    this.statusBarEl.setAttribute("title", "AI Scheduler is running in background. Click to open dashboard.");
    this.statusBarEl.onclick = () => {
      new AssistantModal(this.app, this).open();
    };
    if (this.statusBarTimer === null) {
      this.statusBarTimer = window.setInterval(() => {
        this.updateStatusBar();
      }, 1e3);
    }
  }
};
