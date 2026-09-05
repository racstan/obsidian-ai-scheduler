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
  AISchedulerPlugin: () => AISchedulerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian9 = require("obsidian");

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
var SCHEDULE_KINDS = ["once", "daily", "weekly", "multi", "hourly", "interval", "event", "cron"];

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
    for (; ; ) {
      values.push(value);
      if (value === max) break;
      value = value + 1 > hi ? lo : value + 1;
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
var MAX_SEARCH_YEARS = 4;
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
function nameList(values, names, long) {
  return joinNatural(rangesToList(values).map(([start, end]) => {
    if (start === end) return names[start];
    if (end - start >= 2) return `${names[start]}${long ? "" : ""} to ${names[end]}`;
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
    return `on ${numberList(domDays, "day")} or ${nameList(dowDays, DOW_SHORT, false)}`;
  }
  if (domDays) {
    if (domDays.length === 31) return "every day";
    return `on ${numberList(domDays, "day")} of the month`;
  }
  if (dowDays) {
    if (dowDays.length === 7) return "every day";
    return `on ${nameList(dowDays, DOW_LONG, true)}`;
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
function extractJson(text) {
  const source = String(text || "").trim();
  const candidates = [];
  const marked = /<assistant-scheduler>\s*([\s\S]*?)\s*<\/assistant-scheduler>/i.exec(source);
  if (marked) candidates.push(marked[1]);
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(source);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(source);
  const start = Math.min(...candidates.map((value) => {
    const a = value.indexOf("[");
    const o = value.indexOf("{");
    return a < 0 ? o : o < 0 ? a : Math.min(a, o);
  }).filter((value) => value >= 0));
  if (Number.isFinite(start) && start >= 0) {
    for (const value of candidates) {
      const trimmed = value.trim();
      for (let end = trimmed.length; end > start; end--) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end));
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
        }
      }
    }
  }
  return [];
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

// src/schedule.ts
function parseClock(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 22, minute: 0 };
}
function validClock(value) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}
function nextDailyRun(time, from = /* @__PURE__ */ new Date()) {
  const clock = parseClock(time);
  const candidate = new Date(from);
  candidate.setHours(clock.hour, clock.minute, 0, 0);
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}
function nextWeeklyRun(time, days, from = /* @__PURE__ */ new Date()) {
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
var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var DAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
  if (schedule.kind === "weekly") return validClock(schedule.time) ? nextWeeklyRun(schedule.time, schedule.days, from) : null;
  if (schedule.kind === "multi") return nextMultiRun(schedule.rules, from);
  if (schedule.kind === "hourly" || schedule.kind === "interval") {
    const minutes = scheduleMinutes(schedule);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return new Date(from.getTime() + minutes * 6e4).toISOString();
  }
  if (schedule.kind === "cron") {
    if (!schedule.expression || validateCron(schedule.expression)) return null;
    const next = cronNext(schedule.expression, from);
    return next ? next.toISOString() : null;
  }
  return validClock(schedule.time) ? nextDailyRun(schedule.time, from) : null;
}
function cronFormFor(schedule) {
  if (!schedule) return null;
  if (schedule.kind === "cron") return schedule.expression || null;
  if (schedule.kind === "daily" && validClock(schedule.time)) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} * * *`;
  }
  if (schedule.kind === "weekly" && validClock(schedule.time) && Array.isArray(schedule.days) && schedule.days.length) {
    const clock = parseClock(schedule.time);
    return `${clock.minute} ${clock.hour} * * ${[...new Set(schedule.days.map(Number))].sort((a, b) => a - b).join(",")}`;
  }
  if (schedule.kind === "multi") {
    const rules = normalizeMultiRules(schedule.rules);
    if (!rules.length) return null;
    const firstTimes = JSON.stringify(rules[0].times);
    if (!rules.every((rule) => JSON.stringify(rule.times) === firstTimes)) return null;
    const days = [...new Set(rules.flatMap((rule) => rule.days))].sort((a, b) => a - b);
    if (!days.length || !rules[0].times.length) return null;
    const clock = parseClock(rules[0].times[0]);
    return `${clock.minute} ${clock.hour} * * ${days.join(",")}`;
  }
  return null;
}
function previewSchedule(schedule, count = 3, from = /* @__PURE__ */ new Date()) {
  if (!schedule) return [];
  if (schedule.kind === "event") return ["fires on vault activity"];
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
  if (schedule.kind === "daily") return `daily at ${schedule.time}`;
  if (schedule.kind === "weekly") {
    const days = (schedule.days || []).map(Number).filter((day) => DAY_SHORT_NAMES[day]).map((day) => DAY_SHORT_NAMES[day]);
    return `weekly ${days.join(", ") || "at the selected days"} at ${schedule.time}`;
  }
  if (schedule.kind === "multi") return formatMultiRules(schedule.rules).replace(/\n/g, " \xB7 ") || "multiple times";
  if (schedule.kind === "hourly") return `every hour${schedule.maxIterations ? ` \xB7 ${schedule.maxIterations} iterations` : ""}`;
  if (schedule.kind === "interval") {
    const minutes = Number(schedule.intervalMinutes || legacyField(schedule, "everyMinutes") || Number(legacyField(schedule, "everyHours") || 0) * 60 || 0);
    const cadence = minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `every ${minutes} minutes`;
    return `${cadence}${schedule.maxIterations ? ` \xB7 ${schedule.maxIterations} iterations` : ""}`;
  }
  if (schedule.kind === "event") return `when ${schedule.event || "the vault changes"}`;
  if (schedule.kind === "cron") {
    const expression = schedule.expression || "";
    const description = describeCron(expression);
    return description === "Invalid cron expression" ? `cron ${expression || "(empty)"}` : `${description} \xB7 ${expression}`;
  }
  return job.nextRunAt ? formatDate(job.nextRunAt) : "not scheduled";
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
  catchUpOnStart: false,
  catchUpHours: 24,
  reviewContextMode: "modified-today",
  scheduleNotesEnabled: false,
  scheduleFolder: "AI Schedules"
};
function normalizeJob(raw, now = /* @__PURE__ */ new Date()) {
  var _a;
  const scheduleRaw = raw.schedule || (raw.sendAt ? { kind: "once", at: raw.sendAt } : { kind: "once", at: new Date(Date.now() + 6e4).toISOString() });
  const normalizedSchedule = {
    kind: SCHEDULE_KINDS.includes(String(scheduleRaw.kind)) ? scheduleRaw.kind : "once",
    at: scheduleRaw.at,
    time: scheduleRaw.time,
    days: scheduleRaw.days,
    rules: scheduleRaw.rules,
    event: scheduleRaw.event,
    intervalMinutes: scheduleRaw.intervalMinutes || scheduleRaw.everyMinutes || Number(scheduleRaw.everyHours || 0) * 60,
    maxIterations: normalizeMaxIterationsField(scheduleRaw.maxIterations || scheduleRaw.maxRuns || scheduleRaw.iterations),
    expression: scheduleRaw.expression
  };
  const nextRunAt = raw.nextRunAt !== void 0 ? raw.nextRunAt : getScheduleNextRun(normalizedSchedule, now);
  return Object.assign({
    id: id("job"),
    title: "Assistant task",
    prompt: "",
    tab: 1,
    enabled: true,
    status: "scheduled",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastReply: "",
    lastError: null,
    routine: null,
    notify: true,
    output: null,
    contextPaths: Array.isArray(raw.contextPaths) ? raw.contextPaths : ((_a = raw.context) == null ? void 0 : _a.paths) && Array.isArray(raw.context.paths) ? raw.context.paths : [],
    attempts: 0,
    runCount: Number(raw.runCount || 0),
    taskNumber: Number(raw.taskNumber || 0),
    profile: null,
    conversationId: null,
    providerId: null,
    model: null
  }, raw, { schedule: normalizedSchedule, nextRunAt });
}
function normalizeMaxIterationsField(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function parseStoredData(data) {
  const stored = data || {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
  settings.backendMode = settings.backendMode === "copilot" ? "copilot" : "claudian";
  const oldSettings = stored.settings || {};
  const oldDefault = oldSettings.defaultProfile || oldSettings.planningProfile || "";
  settings.planningModel = settings.planningModel || oldSettings.planningProfile || oldDefault;
  settings.executionModel = settings.executionModel || oldDefault;
  settings.dailyReviewModel = settings.dailyReviewModel || oldSettings.nightlyProfile || oldDefault;
  settings.nightlyReviewModel = settings.nightlyReviewModel || oldSettings.nightlyProfile || oldDefault;
  if (!stored.version || stored.version < 3) settings.catchUpOnStart = false;
  if (typeof settings.scheduleNotesEnabled !== "boolean") settings.scheduleNotesEnabled = false;
  if (!settings.scheduleFolder) settings.scheduleFolder = DEFAULT_SETTINGS.scheduleFolder;
  const legacyTasks = stored.tasks;
  const jobs = Array.isArray(stored.jobs) ? stored.jobs.map((job) => normalizeJob(job)) : Array.isArray(legacyTasks) ? legacyTasks.map((task) => normalizeJob({
    ...task,
    title: task.title || "Migrated task",
    prompt: task.prompt || task.content || "",
    schedule: { kind: "once", at: task.sendAt },
    enabled: task.status === "pending"
  })) : [];
  const activity = Array.isArray(stored.activity) ? stored.activity.slice(-50) : [];
  return { settings, jobs, activity };
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
  const cutoff = now - Number(settings.catchUpHours || 24) * 60 * 60 * 1e3;
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
  return [
    "You are the planning brain for an autonomous Obsidian AI Scheduler.",
    "Turn the user goal below into one or more safe, concrete automation jobs.",
    "Return ONLY a JSON array inside <assistant-scheduler> tags. No Markdown outside the tags.",
    "Each item must have: title, prompt, schedule.",
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
var AGENT_TIMEOUT_MS = 30 * 60 * 1e3;
function pluginRegistry(host) {
  const app = host.app;
  const registry = app.plugins && app.plugins.plugins;
  return registry || null;
}
function getClaudianPlugin(host) {
  const plugins = pluginRegistry(host);
  if (!plugins) return null;
  return plugins.realclaudian || plugins.claudian || null;
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
  if (!tab) return false;
  const manager = getTabManager(view);
  const item = manager && typeof manager.getTabBarItems === "function" ? manager.getTabBarItems().find((candidate) => candidate.id === tab.id) : null;
  const working = manager && typeof manager.isTabWorking === "function" ? manager.isTabWorking(tab.id) : false;
  return Boolean(working || tab.state && tab.state.isStreaming || tab.isStreaming || item && (item.isWorking || item.isStreaming));
}
async function waitForTabIdle(view, tab) {
  const started = Date.now();
  while (tabIsBusy(view, tab)) {
    if (Date.now() - started > AGENT_TIMEOUT_MS) throw new Error("Claudian chat stayed busy for 30 minutes");
    await sleep(1e3);
  }
}
function getTabMessages(host, view, tab) {
  const direct = tab && tab.state && Array.isArray(tab.state.messages) ? tab.state.messages : [];
  if (direct.length) return direct;
  const conversationId = tab && tab.conversationId;
  const claudian = getClaudianPlugin(host);
  const conversation = conversationId && claudian && typeof claudian.getConversationSync === "function" ? claudian.getConversationSync(conversationId) : null;
  return conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
}
function lastAssistantReply(host, view, tab, beforeCount) {
  const messages = getTabMessages(host, view, tab);
  const candidates = messages.slice(Math.max(0, beforeCount)).filter((message2) => message2.role === "assistant");
  const fallback = messages.filter((message2) => message2.role === "assistant");
  const messagesToUse = candidates.length ? candidates : fallback;
  const message = messagesToUse[messagesToUse.length - 1];
  return contentFromMessage(message).trim();
}
async function sendToClaudian(host, prompt, tabNumber = host.settings.assistantTab, conversationId = null, context = null) {
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
  const controller = active && active.controllers && active.controllers.inputController;
  if (!controller || typeof controller.sendMessage !== "function") throw new Error("Claudian input controller is unavailable.");
  const turnRequest = { text: prompt };
  if (context && context.linkedContentPath) turnRequest.linkedContentPath = context.linkedContentPath;
  if (context && context.externalContextPaths && context.externalContextPaths.length) {
    turnRequest.externalContextPaths = context.externalContextPaths;
  }
  const send = controller.sendMessage({ content: prompt, turnRequestOverride: turnRequest });
  await Promise.race([
    send,
    sleep(AGENT_TIMEOUT_MS).then(() => {
      throw new Error("AI task timed out after 30 minutes");
    })
  ]);
  await waitForTabIdle(view, active);
  await sleep(300);
  return lastAssistantReply(host, view, active, beforeCount);
}
function getCopilotPlugin(host) {
  const plugins = pluginRegistry(host);
  if (!plugins) return null;
  return plugins.copilot || plugins["obsidian-copilot"] || null;
}
async function sendToCopilot(host, prompt, context = null) {
  const copilot = getCopilotPlugin(host);
  const chatManager = copilot && copilot.chatManager;
  const chain = copilot && copilot.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === "function" ? copilot.chainOwner.getCurrentChainManager() : null;
  if (!copilot) throw new Error("Obsidian Copilot is not installed or enabled. Install or enable Copilot, then try again.");
  if (!chatManager || typeof chatManager.sendMessage !== "function" || typeof chatManager.getLLMMessage !== "function" || !chain || typeof chain.runChain !== "function") {
    throw new Error("Obsidian Copilot is installed, but its automation API is unavailable. Update Copilot and try again.");
  }
  const paths = context && Array.isArray(context.paths) ? context.paths : [];
  const notes = paths.map((path) => host.app.vault.getAbstractFileByPath(path)).filter((file) => file && !Array.isArray(file.children));
  const folders = paths.map((path) => host.app.vault.getAbstractFileByPath(path)).filter((file) => file && Array.isArray(file.children)).map((file) => file.path);
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
  await Promise.race([
    run,
    sleep(AGENT_TIMEOUT_MS).then(() => {
      throw new Error("AI task timed out after 30 minutes");
    })
  ]);
  return String(reply || "").trim();
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
  return names[providerId || ""] || providerId || "Claudian";
}
function modelValue(providerId, model) {
  return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || "" }))}`;
}
function parseProfileValue(value) {
  if (!String(value || "").startsWith("profile:")) return null;
  try {
    return JSON.parse(decodeURIComponent(String(value).slice(8)));
  } catch (e) {
    return null;
  }
}
function getClaudianViewSync(host) {
  const claudian = getClaudianPlugin(host);
  return claudian && typeof claudian.getAllViews === "function" ? claudian.getAllViews()[0] || null : null;
}
function getModelOptions(host) {
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
    const conversation = tab.conversationId && claudian && typeof claudian.getConversationSync === "function" ? claudian.getConversationSync(tab.conversationId) : null;
    const providerId = conversation && conversation.providerId;
    if (providerId && conversation.selectedModel) add({
      value: modelValue(providerId, conversation.selectedModel),
      label: `${getProviderName(providerId)} / ${conversation.selectedModel}`,
      providerId,
      model: conversation.selectedModel
    });
    if (providerId && tab.ui && tab.ui.modelSelector && typeof tab.ui.modelSelector.getAvailableModels === "function") {
      try {
        tab.ui.modelSelector.getAvailableModels().forEach((option) => add({
          value: modelValue(providerId, option.value),
          label: `${getProviderName(providerId)} / ${option.label || option.value}`,
          providerId,
          model: option.value
        }));
      } catch (e) {
      }
    }
  });
  const settings = claudian && (claudian.settings || claudian.providerHost && claudian.providerHost.settings) || {};
  const savedModels = settings.savedProviderModel || {};
  const last = settings.lastSelectedChatModel;
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
    model: String(model || "")
  }));
  const settingsProvider = settings.settingsProvider;
  const settingsModel = settingsProvider && (savedModels[settingsProvider] || settings.model);
  if (settingsProvider) add({
    value: modelValue(settingsProvider, settingsModel),
    label: `${getProviderName(settingsProvider)} / ${settingsModel || "current model"}`,
    providerId: settingsProvider,
    model: String(settingsModel || "")
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
  return mode === "copilot" ? checkCopilotSetup(host) : checkClaudianSetup(host);
}
async function resolveModel(host, value, action = "this action") {
  if (host.settings.backendMode === "copilot") {
    const setup = checkCopilotSetup(host);
    if (!setup.ok) {
      const installHint = setup.needsInstall ? ` Install it from ${setup.githubUrl}.` : "";
      throw new Error(`${setup.message}${installHint} It is the active AI Scheduler backend for ${action}.`);
    }
    return { modelRef: "copilot", tab: null, conversationId: null, providerId: "copilot", model: null };
  }
  const selected = value === void 0 || value === null ? host.settings.executionModel : value;
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
  if (String(selected).startsWith("tab:")) {
    const tab = Math.max(1, Number.parseInt(String(selected).slice(4), 10) || 1);
    const view = await getClaudianView(host);
    const runtime = getTab(host, view, tab);
    if (!runtime) throw new Error(`The Claudian chat selected for ${action} no longer exists. Refresh the model list and choose another model.`);
    const claudian = getClaudianPlugin(host);
    const conversation = runtime && runtime.conversationId && claudian && typeof claudian.getConversationSync === "function" ? claudian.getConversationSync(runtime.conversationId) : null;
    if (!conversation || !conversation.providerId) throw new Error(`The Claudian chat selected for ${action} has no configured provider.`);
    return { modelRef: selected, tab, conversationId: runtime && runtime.conversationId || null, providerId: conversation && conversation.providerId || null, model: conversation && conversation.selectedModel || null };
  }
  const profile = parseProfileValue(selected);
  if (profile && profile.providerId) {
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
      throw new Error(`Claudian could not create the selected model for ${action}: ${String((error == null ? void 0 : error.message) || error)}`);
    }
    if (!conversation || !conversation.id) throw new Error(`Claudian returned no conversation for ${action}.`);
    if (conversation && conversation.id && typeof claudian.renameConversation === "function") {
      await claudian.renameConversation(conversation.id, "AI Scheduler - Planning");
    }
    return { modelRef: selected, tab: host.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
  }
  return { modelRef: "", tab: host.settings.assistantTab, conversationId: null, providerId: null, model: null };
}
async function resolveJobExecution(host, job) {
  const selectedModel = job.routine === "daily-review" ? host.settings.nightlyReviewModel : host.settings.executionModel;
  const action = job.routine === "daily-review" ? "nightly review" : "scheduled task execution";
  return resolveModel(host, selectedModel, action);
}

// src/ui/AssistantModal.ts
var import_obsidian6 = require("obsidian");

// src/ui/dom.ts
function makeButton(parent, label, onClick, primary = false, danger = false) {
  const button = parent.createEl("button", { text: label });
  if (primary) button.addClass("mod-cta");
  if (danger) {
    button.addClass("mod-warning");
    button.addClass("ai-scheduler-button-danger");
  }
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

// src/ui/JobModal.ts
var import_obsidian4 = require("obsidian");

// src/ui/contextPicker.ts
var import_obsidian3 = require("obsidian");
function createContextPicker(parent, options, initialPaths, app) {
  const card = makeCard(parent, "ai-scheduler-card-flush");
  card.createDiv("ai-scheduler-lead").setText("Context for this task");
  card.createDiv("ai-scheduler-picker-desc").setText("Select pages or project folders the active backend should attach when this task runs.");
  const select = card.createEl("select");
  select.multiple = true;
  select.size = 6;
  select.addClass("ai-scheduler-picker-select");
  const known = new Set(options.map((option) => option.path));
  for (const path of initialPaths) {
    if (!known.has(path)) options.push({ path, label: `Unavailable: ${path}`, type: "missing" });
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  options.forEach((option) => {
    const element = select.createEl("option", { value: option.path, text: option.label });
    element.selected = initialPaths.includes(option.path);
  });
  const controls = card.createDiv("ai-scheduler-picker-controls");
  makeButton(controls, "Use active page", () => {
    const active = app.workspace && app.workspace.getActiveFile && app.workspace.getActiveFile();
    if (!active) {
      new import_obsidian3.Notice("No active Markdown page is open.");
      return;
    }
    const option = Array.from(select.options).find((candidate) => candidate.value === active.path);
    if (option) option.selected = true;
    else new import_obsidian3.Notice(`Active page is not available: ${active.path}`);
  });
  makeButton(controls, "Clear context", () => Array.from(select.options).forEach((option) => {
    option.selected = false;
  }));
  return { getPaths: () => Array.from(select.selectedOptions).map((option) => option.value) };
}

// src/ui/JobModal.ts
var KIND_LABELS = {
  once: "Once at a specific time",
  daily: "Every day",
  weekly: "Weekly on selected days",
  multi: "Multiple weekday/time rules",
  hourly: "Every hour",
  interval: "Every N minutes",
  event: "When the vault changes",
  cron: "Cron expression (advanced)"
};
var JobModal = class extends import_obsidian4.Modal {
  constructor(app, plugin, job, onSaved) {
    super(app);
    this.inputs = [];
    this.multiArea = null;
    this.dayChecks = [];
    this.cronInput = null;
    this.kindSelect = null;
    this.plugin = plugin;
    this.job = job;
    this.onSaved = onSaved;
    this.kind = job.schedule.kind;
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-sm");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv("ai-scheduler-shell ai-scheduler-shell-tight");
    shell.createEl("h2", { text: "Edit scheduled task" });
    shell.createEl("p", { text: "Adjust the schedule directly, or describe a change in plain language and let AI rewrite it." }).addClass("ai-scheduler-subtitle");
    const current = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
    current.createDiv({ text: this.job.title }).addClass("ai-scheduler-task-title");
    current.createDiv({ text: describeSchedule(this.job) }).addClass("ai-scheduler-task-meta");
    current.createDiv({ text: this.job.prompt }).addClass("ai-scheduler-task-prompt");
    this.renderScheduleEditor(shell);
    const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
    shell.createDiv("ai-scheduler-form-label").setText("Result folder for this task (optional)");
    const resultFolder = shell.createEl("input", { type: "text", value: this.job.output && this.job.output.folder || "", placeholder: "Optional result folder, e.g. Projects/News" });
    resultFolder.addClass("ai-scheduler-input");
    resultFolder.addClass("ai-scheduler-form-gap");
    const footer = shell.createDiv("ai-scheduler-footer-wrap");
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
        await this.plugin.updateJob(this.job, { schedule: state.schedule, contextPaths: contextPicker.getPaths(), output, cooldownMinutes: state.cooldownMinutes });
        new import_obsidian4.Notice("Schedule updated and saved.", 6e3);
        this.onSaved();
        this.close();
      } catch (error) {
        new import_obsidian4.Notice(`Could not update task: ${errorText(error)}`, 8e3);
      }
    }, true);
    const aiSection = makeCard(shell, "ai-scheduler-card-ai");
    aiSection.createDiv("ai-scheduler-lead ai-scheduler-gap-6").setText("Edit with AI (optional)");
    const request = aiSection.createEl("textarea", { placeholder: "Example: Change this to run every 30 minutes for 8 iterations, and save each result in Projects/News." });
    request.addClass("ai-scheduler-textarea");
    request.addClass("ai-scheduler-textarea-ai");
    makeButton(aiSection, "Update task with AI", async (button) => {
      const change = request.value.trim();
      if (!change) {
        new import_obsidian4.Notice("Describe the task change first.");
        return;
      }
      button.disabled = true;
      try {
        const contextPaths = contextPicker.getPaths();
        const plan = await this.plugin.refineJob(this.job, change, contextPaths);
        const schedule = plan.schedule || this.job.schedule;
        if (schedule.kind !== "event" && !getScheduleNextRun(schedule, new Date(Date.now() - 1e3))) throw new Error("AI returned an invalid schedule. Ask for a concrete time or cadence.");
        const folder = resultFolder.value.trim();
        const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
        await this.plugin.updateJob(this.job, { title: String(plan.title).trim(), prompt: String(plan.prompt).trim(), schedule, contextPaths, output });
        new import_obsidian4.Notice("AI updated and saved the scheduled task.", 6e3);
        this.onSaved();
        this.close();
      } catch (error) {
        new import_obsidian4.Notice(`Could not update task: ${errorText(error)}`, 8e3);
        button.disabled = false;
      }
    }, true);
  }
  /* Manual schedule editor: one dynamic field group per kind, with a live
   * next-runs preview. Cron expressions are validated on every keystroke. */
  renderScheduleEditor(shell) {
    const card = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-flush");
    card.createDiv("ai-scheduler-lead ai-scheduler-gap-8").setText("Schedule");
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
      this.inputs = [];
      this.multiArea = null;
      this.dayChecks = [];
      this.cronInput = null;
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
    const input = (attributes) => {
      const element = container.createEl("input", { type: attributes.type || "text" });
      if (attributes.value !== void 0) element.value = attributes.value;
      if (attributes.min !== void 0) element.min = attributes.min;
      if (attributes.placeholder !== void 0) element.placeholder = attributes.placeholder;
      element.addClass("ai-scheduler-input");
      if (attributes.monospace) element.addClass("ai-scheduler-input-mono");
      element.oninput = onChange;
      this.inputs.push(element);
      return element;
    };
    const label = (text) => container.createDiv("ai-scheduler-field-label").setText(text);
    switch (this.kind) {
      case "once": {
        label("Date and time");
        const current = schedule.at ? new Date(schedule.at) : new Date(Date.now() + 60 * 60 * 1e3);
        const pad2 = (value) => String(value).padStart(2, "0");
        input({
          type: "datetime-local",
          value: `${current.getFullYear()}-${pad2(current.getMonth() + 1)}-${pad2(current.getDate())}T${pad2(current.getHours())}:${pad2(current.getMinutes())}`
        });
        break;
      }
      case "daily": {
        label("Time (HH:MM)");
        input({ type: "time", value: schedule.time || "09:00" });
        break;
      }
      case "weekly": {
        label("Time (HH:MM)");
        input({ type: "time", value: schedule.time || "09:00" });
        label("Days");
        const row = container.createDiv("ai-scheduler-days");
        DAY_SHORT_NAMES.forEach((day, index) => {
          const item = row.createEl("label");
          const checkbox = item.createEl("input", { type: "checkbox" });
          checkbox.checked = Array.isArray(schedule.days) ? schedule.days.includes(index) : false;
          checkbox.onchange = onChange;
          item.createSpan({ text: day });
          this.dayChecks.push(checkbox);
        });
        break;
      }
      case "multi": {
        label("Rules, one per line: days = HH:MM, HH:MM (e.g. Mon-Fri = 09:00)");
        const area = container.createEl("textarea", { text: formatMultiRules(schedule.rules) });
        area.addClass("ai-scheduler-textarea");
        area.addClass("ai-scheduler-textarea-short");
        area.oninput = onChange;
        this.multiArea = area;
        break;
      }
      case "hourly": {
        label("Stop after this many runs (optional)");
        input({ type: "number", value: schedule.maxIterations ? String(schedule.maxIterations) : "", min: "1", placeholder: "unlimited" });
        break;
      }
      case "interval": {
        label("Interval in minutes");
        input({ type: "number", value: String(schedule.intervalMinutes || 30), min: "1" });
        label("Stop after this many runs (optional)");
        input({ type: "number", value: schedule.maxIterations ? String(schedule.maxIterations) : "", min: "1", placeholder: "unlimited" });
        break;
      }
      case "event": {
        label("Vault event");
        const select = container.createEl("select");
        select.addClass("ai-scheduler-select");
        select.createEl("option", { value: "modify", text: "Any file is modified or created" });
        select.onchange = onChange;
        label("Cooldown minutes between runs");
        input({ type: "number", value: String((_a = this.job.cooldownMinutes) != null ? _a : 10), min: "1" });
        break;
      }
      case "cron": {
        label("5-field cron: minute, hour, day-of-month, month, day-of-week (0 = Sunday)");
        this.cronInput = input({
          type: "text",
          value: schedule.expression || "",
          placeholder: "*/15 * * * *   or   0 9 * * 1-5",
          monospace: true
        });
        container.createDiv("ai-scheduler-example").setText("Examples: */15 * * * * every 15 minutes \xB7 0 9 * * 1-5 weekdays at 09:00 \xB7 0 22 * * * daily at 22:00");
        break;
      }
    }
  }
  readEditorState() {
    const previous = this.job.schedule;
    const numbers = this.inputs.filter((input) => input.type === "number").map((input) => Number.parseInt(input.value, 10)).filter((value) => Number.isFinite(value));
    const byKind = () => {
      var _a;
      switch (this.kind) {
        case "once": {
          const field = this.inputs.find((input) => input.type === "datetime-local");
          const date = field && field.value ? new Date(field.value) : null;
          return {
            schedule: {
              kind: "once",
              at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : previous.at
            }
          };
        }
        case "daily": {
          const field = this.inputs.find((input) => input.type === "time");
          return { schedule: { kind: "daily", time: field && field.value ? field.value : previous.time || "09:00" } };
        }
        case "weekly": {
          const field = this.inputs.find((input) => input.type === "time");
          const days = this.dayChecks.map((checkbox, index) => checkbox.checked ? index : -1).filter((index) => index >= 0);
          return { schedule: { kind: "weekly", time: field && field.value ? field.value : previous.time || "09:00", days } };
        }
        case "multi": {
          const rules = this.multiArea ? parseMultiRulesText(this.multiArea.value) : previous.rules || [];
          return { schedule: { kind: "multi", rules } };
        }
        case "hourly": {
          const max = numbers.length && numbers[0] > 0 ? numbers[0] : null;
          return { schedule: { kind: "hourly", maxIterations: max } };
        }
        case "interval": {
          const minutes = numbers.length && numbers[0] > 0 ? numbers[0] : Number(previous.intervalMinutes || 30);
          const max = numbers.length > 1 && numbers[1] > 0 ? numbers[1] : null;
          return { schedule: { kind: "interval", intervalMinutes: minutes, maxIterations: max } };
        }
        case "event": {
          return {
            schedule: { kind: "event", event: "modify" },
            cooldownMinutes: numbers.length && numbers[0] > 0 ? numbers[0] : (_a = this.job.cooldownMinutes) != null ? _a : 10
          };
        }
        case "cron": {
          return { schedule: { kind: "cron", expression: this.cronInput ? this.cronInput.value.trim() : previous.expression || "" } };
        }
      }
    };
    return byKind();
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
    this.inputs = [];
    this.multiArea = null;
    this.dayChecks = [];
    this.cronInput = null;
    this.kindSelect = null;
  }
};

// src/ui/PlannerModal.ts
var import_obsidian5 = require("obsidian");
var PlannerModal = class extends import_obsidian5.Modal {
  constructor(app, plugin) {
    super(app);
    this.planned = null;
    this.plugin = plugin;
  }
  async onOpen() {
    if (this.planned) this.renderResults();
    else await this.renderForm();
  }
  async renderForm() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-md");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv("ai-scheduler-shell ai-scheduler-shell-md");
    shell.createDiv("ai-scheduler-eyebrow").setText("AI PLANNER");
    shell.createEl("h1", { text: "Plan scheduled work" }).addClass("ai-scheduler-title ai-scheduler-title-sm");
    shell.createEl("p", { text: "Describe the outcome. Your selected backend will turn it into safe, persistent jobs." }).addClass("ai-scheduler-subtitle");
    const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);
    shell.createDiv("ai-scheduler-form-label").setText("Default result folder for created tasks (optional)");
    const resultFolder = shell.createEl("input", { type: "text", placeholder: "Optional result folder for created tasks, e.g. Projects/News" });
    resultFolder.addClass("ai-scheduler-input");
    resultFolder.addClass("ai-scheduler-form-gap");
    const textarea = shell.createEl("textarea");
    textarea.addClass("ai-scheduler-textarea");
    textarea.addClass("ai-scheduler-textarea-tall");
    textarea.placeholder = "Every evening, review the notes I changed today, identify open loops, and create a report in AI Reviews. Remind me every Monday to review unfinished work.";
    shell.createDiv("ai-scheduler-hint ai-scheduler-hint-gap").setText("Examples: review notes every evening, run every 30 minutes for 8 iterations, run every 2 hours until I stop it, remind me every Monday, or react when a project file changes.");
    const footer = shell.createDiv("ai-scheduler-footer");
    makeButton(footer, "Cancel", () => this.close());
    makeButton(footer, "Create AI plan", async (button) => {
      const goal = textarea.value.trim();
      if (!goal) {
        new import_obsidian5.Notice("Describe what you want AI Scheduler to do.");
        return;
      }
      button.disabled = true;
      try {
        const result = await this.plugin.planAndCreate(goal, contextPicker.getPaths(), resultFolder.value.trim());
        new import_obsidian5.Notice(`AI created ${result.jobs.length} job(s)`, 6e3);
        this.planned = result.jobs.map((job) => ({ taskNumber: job.taskNumber, title: job.title, schedule: job.schedule }));
        await this.onOpen();
      } catch (error) {
        new import_obsidian5.Notice(`Planning failed: ${errorText(error)}`, 8e3);
        button.disabled = false;
      }
    }, true);
  }
  /* After planning, show the created schedules in a table (cron form, plain
   * English, and the next concrete run times) before moving on. */
  renderResults() {
    const { contentEl } = this;
    this.modalEl.addClass("ai-scheduler-modal");
    this.modalEl.addClass("ai-scheduler-modal-lg");
    contentEl.addClass("ai-scheduler-content");
    contentEl.empty();
    const shell = contentEl.createDiv("ai-scheduler-shell ai-scheduler-shell-lg");
    shell.createEl("h1", { text: "Schedule created" }).addClass("ai-scheduler-title ai-scheduler-title-sm");
    shell.createEl("p", { text: "Your tasks are scheduled. The cron form is shown for reference \u2014 the scheduler uses it behind the scenes." }).addClass("ai-scheduler-subtitle");
    const table = shell.createEl("table");
    table.addClass("ai-scheduler-result-table");
    const head = table.createEl("tr");
    ["Task", "Cron form", "Schedule", "Next runs"].forEach((label) => {
      head.createEl("th", { text: label });
    });
    for (const planned of this.planned || []) {
      const row = table.createEl("tr");
      const runs = previewSchedule(planned.schedule, 3);
      const cronForm = cronFormFor(planned.schedule);
      const titleCell = row.createEl("td");
      titleCell.setText(`#${planned.taskNumber} \xB7 ${planned.title}`);
      const cronCell = row.createEl("td");
      if (cronForm) cronCell.createEl("code", { text: cronForm });
      else cronCell.setText("\u2014");
      row.createEl("td").setText(describeSchedule({ schedule: planned.schedule }));
      row.createEl("td").setText(runs.length ? runs.join(" \xB7 ") : "on trigger");
    }
    const summary = makeCard(shell, "ai-scheduler-card-tight", "ai-scheduler-card-gap");
    summary.createDiv({ text: "You can edit any task from the dashboard or its schedule note; the AI can also rewrite schedules in plain language." }).addClass("ai-scheduler-hint");
    const footer = shell.createDiv("ai-scheduler-footer");
    makeButton(footer, "Close", () => this.close());
    makeButton(footer, "Open AI Scheduler", () => {
      this.close();
      new AssistantModal(this.app, this.plugin).open();
    }, true);
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/ui/AssistantModal.ts
var AssistantModal = class extends import_obsidian6.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    this.render();
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
    const actions = shell.createDiv("ai-scheduler-actions");
    makeButton(actions, "Ask AI to plan", () => new PlannerModal(this.app, this.plugin).open(), true);
    makeButton(actions, "Run daily preview", () => this.plugin.startReviewRun(true, "daily"));
    const userJobs = this.plugin.jobs.filter((job) => !isNightlyReviewJob(job));
    const activeCount = userJobs.filter((job) => job.enabled).length;
    const next = userJobs.filter((job) => job.enabled && job.nextRunAt).sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())[0];
    const stats = shell.createDiv("ai-scheduler-stats");
    [[activeCount, "ACTIVE TASKS"], [next ? formatDate(next.nextRunAt) : "None", "NEXT RUN"], [this.plugin.settings.nightlyReviewEnabled ? "ON" : "OFF", "NIGHTLY REVIEW"]].forEach(([value, label]) => {
      const stat = makeCard(stats, "ai-scheduler-card-stat");
      stat.createDiv({ text: String(value) }).addClass("ai-scheduler-stat-value");
      stat.createDiv({ text: label }).addClass("ai-scheduler-stat-label");
    });
    this.renderSection(shell, "Scheduled tasks", `${activeCount} ${activeCount === 1 ? "task" : "tasks"} enabled`);
    const bulkActions = shell.createDiv("ai-scheduler-row-actions");
    makeButton(bulkActions, "Enable all", async () => {
      await this.plugin.enableAllJobs();
      this.render();
    });
    makeButton(bulkActions, "Disable all", async () => {
      if (!window.confirm("Disable all scheduled tasks?")) return;
      await this.plugin.disableAllJobs();
      this.render();
    }, false, true);
    makeButton(bulkActions, "Delete all", async () => {
      if (!window.confirm("Delete all scheduled tasks? This cannot be undone.")) return;
      await this.plugin.deleteAllJobs();
      this.render();
    }, false, true);
    const scheduled = userJobs.filter((job) => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    const jobs = shell.createDiv();
    if (!scheduled.length) {
      const empty = makeCard(jobs, "ai-scheduler-card-muted");
      empty.createDiv({ text: "No scheduled tasks yet." });
      empty.createDiv({ text: "Ask AI to plan a schedule from a plain-language goal." }).addClass("ai-scheduler-empty-sub");
    }
    for (const job of scheduled) {
      const card = makeCard(jobs, "ai-scheduler-task-card");
      const copy = card.createDiv();
      copy.createDiv({ text: `#${job.taskNumber} \xB7 ${job.title}` }).addClass("ai-scheduler-task-title");
      copy.createDiv({ text: `${describeBinding(job)} \xB7 ${describeSchedule(job)}${job.runCount ? ` \xB7 ${job.runCount} run${job.runCount === 1 ? "" : "s"}` : ""}` }).addClass("ai-scheduler-task-meta");
      const controls = card.createDiv("ai-scheduler-task-actions");
      makeButton(controls, "Edit", () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
      makeButton(controls, "Disable", async () => {
        job.enabled = false;
        job.nextRunAt = null;
        job.status = "disabled";
        job.lastStatus = "disabled";
        await this.plugin.saveState();
        this.render();
      }, false, true);
      makeButton(controls, "Delete", async () => {
        if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
        await this.plugin.deleteJob(job);
        this.render();
      }, false, true);
    }
    const disabled = summarizeTasks(userJobs.filter((job) => isDisabledTask(job))).slice(-8).reverse();
    if (disabled.length) {
      this.renderSection(shell, "Disabled tasks", "Paused and ready to enable");
      const disabledList = shell.createDiv();
      for (const job of disabled) {
        const card = makeCard(disabledList, "ai-scheduler-task-card");
        const copy = card.createDiv();
        copy.createDiv({ text: `#${job.taskNumber} \xB7 ${job.title}` }).addClass("ai-scheduler-task-title");
        copy.createDiv({ text: `${describeBinding(job)} \xB7 ${describeSchedule(job)} \xB7 Disabled` }).addClass("ai-scheduler-task-meta");
        const controls = card.createDiv("ai-scheduler-task-actions");
        makeButton(controls, "Edit", () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
        makeButton(controls, "Enable", async () => {
          await this.plugin.enableJob(job);
          this.render();
        });
        makeButton(controls, "Delete", async () => {
          if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
          await this.plugin.deleteJob(job);
          this.render();
        }, false, true);
      }
    }
    const past = summarizeTasks(userJobs.filter((job) => !job.enabled && !isDisabledTask(job))).slice(-8).reverse();
    if (past.length) {
      this.renderSection(shell, "Past tasks", "Completed or failed tasks, summarized per task");
      const pastList = shell.createDiv();
      for (const job of past) {
        const card = makeCard(pastList, "ai-scheduler-task-card");
        const copy = card.createDiv();
        copy.createDiv({ text: `#${job.taskNumber} \xB7 ${job.title}` }).addClass("ai-scheduler-task-title");
        copy.createDiv({ text: `${describeBinding(job)} \xB7 ${job.lastStatus || job.status || "completed"}${job.runCount ? ` \xB7 ${job.runCount} run${job.runCount === 1 ? "" : "s"}` : ""}${job.lastRunAt ? ` \xB7 Last run ${formatDate(job.lastRunAt)}` : ""}` }).addClass("ai-scheduler-task-meta");
        const controls = card.createDiv("ai-scheduler-task-actions");
        makeButton(controls, "Edit", () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
        makeButton(controls, "Run again", async () => {
          await this.plugin.retryJob(job);
          this.render();
        });
        makeButton(controls, "Delete", async () => {
          if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
          await this.plugin.deleteJob(job);
          this.render();
        }, false, true);
      }
    }
    const activity = this.plugin.activity.slice(-8).reverse();
    const activityHeading = this.renderSection(shell, "Recent activity", activity.length ? "All times are local" : "No activity yet");
    makeButton(activityHeading, "Clear", async (button) => {
      button.disabled = true;
      await this.plugin.clearActivity();
      this.render();
    });
    const activityCard = makeCard(shell.createDiv(), "ai-scheduler-activity");
    if (!activity.length) activityCard.createDiv({ text: "Reviews, task runs, and notifications will appear here." }).addClass("ai-scheduler-activity-empty");
    for (const event of activity) {
      const row = activityCard.createDiv("ai-scheduler-activity-row");
      row.createSpan({ text: event.message });
      row.createSpan({ text: formatDate(event.at) }).addClass("ai-scheduler-activity-time");
    }
  }
  renderSection(parent, title, description) {
    const heading = parent.createDiv("ai-scheduler-section-heading");
    heading.createEl("h2", { text: title }).addClass("ai-scheduler-section-title");
    heading.createSpan({ text: description }).addClass("ai-scheduler-section-desc");
    return heading;
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/ui/SettingsTab.ts
var import_obsidian7 = require("obsidian");
var AssistantSettingTab = class extends import_obsidian7.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  renderBackendStatus(containerEl) {
    const info = BACKEND_INFO[this.plugin.settings.backendMode === "copilot" ? "copilot" : "claudian"];
    const setting = new import_obsidian7.Setting(containerEl).setName("Active backend").setDesc("Checking readiness...");
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
    const installed = this.plugin.settings.backendMode === "copilot" ? Boolean(this.plugin.getCopilotPlugin()) : Boolean(this.plugin.getClaudianPlugin());
    if (!installed) {
      update({ ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl });
      return;
    }
    void Promise.resolve(this.plugin.checkBackendSetup()).then(update).catch((error) => {
      update({ ok: false, needsInstall: false, message: errorText(error), githubUrl: info.githubUrl });
    });
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Choose one AI backend. AI Scheduler never runs Claudian and Copilot at the same time." });
    new import_obsidian7.Setting(containerEl).setName("AI backend").setDesc("Claudian uses the model choices below. Copilot uses the active model configured in Obsidian Copilot.").addDropdown((dropdown) => dropdown.addOption("claudian", "Claudian").addOption("copilot", "Obsidian Copilot").setValue(this.plugin.settings.backendMode === "copilot" ? "copilot" : "claudian").onChange((value) => {
      void (async () => {
        this.plugin.settings.backendMode = value === "copilot" ? "copilot" : "claudian";
        await this.plugin.saveState();
        this.display();
      })();
    }));
    this.renderBackendStatus(containerEl);
    const models = this.plugin.settings.backendMode === "copilot" ? [] : this.plugin.getModelOptions();
    if (this.plugin.settings.backendMode === "claudian") {
      new import_obsidian7.Setting(containerEl).setName("Available Claudian models").setDesc("Refresh this list after adding, removing, or changing models in Claudian.").addButton((button) => button.setButtonText("Refresh models").onClick(() => {
        void (async () => {
          button.setDisabled(true);
          try {
            await this.plugin.refreshModels();
            new import_obsidian7.Notice("Claudian model list refreshed.");
            this.display();
          } catch (error) {
            new import_obsidian7.Notice(`Could not refresh models: ${errorText(error)}`, 8e3);
            button.setDisabled(false);
          }
        })();
      }));
      const addModelSetting = (name, desc, key) => new import_obsidian7.Setting(containerEl).setName(name).setDesc(desc).addDropdown((dropdown) => {
        dropdown.addOption("", models.length ? "Select a model" : "No models found - open Claudian");
        models.forEach((model) => dropdown.addOption(model.value, model.label));
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
    new import_obsidian7.Setting(containerEl).setName("Test notification").setDesc("Send a normal Obsidian notification visible across the app, without using AI.").addButton((button) => button.setButtonText("Send test notification").onClick(() => this.plugin.testNotification()));
    new import_obsidian7.Setting(containerEl).setName("Review context").setDesc("Files the daily and nightly reviews may inspect through the active backend's vault tools.").addDropdown((dropdown) => dropdown.addOption("modified-today", "Markdown files modified today").addOption("all-markdown", "All Markdown files").addOption("no-files", "No automatic files").setValue(this.plugin.settings.reviewContextMode).onChange((value) => {
      void (async () => {
        this.plugin.settings.reviewContextMode = value;
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian7.Setting(containerEl).setName("Review report folder").setDesc("Reports are saved as YYYY-MM-DD-HHmmss.md so every run is preserved.").addText((text) => text.setValue(this.plugin.settings.reportFolder).onChange((value) => {
      void (async () => {
        this.plugin.settings.reportFolder = value.trim() || "AI Reviews";
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian7.Setting(containerEl).setName("Nightly review").setDesc("Opt-in: create a timestamped review report on a recurring schedule.").addToggle((toggle) => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange((value) => {
      void (async () => {
        const previous = this.plugin.settings.nightlyReviewEnabled;
        try {
          this.plugin.settings.nightlyReviewEnabled = value;
          await this.plugin.ensureNightlyReviewJob();
          await this.plugin.saveState();
          new import_obsidian7.Notice(value ? "Nightly review enabled." : "Nightly review disabled.");
          this.display();
        } catch (error) {
          this.plugin.settings.nightlyReviewEnabled = previous;
          toggle.setValue(previous);
          new import_obsidian7.Notice(`Could not change nightly review: ${errorText(error)}`, 8e3);
        }
      })();
    }));
    if (this.plugin.settings.nightlyReviewEnabled) {
      new import_obsidian7.Setting(containerEl).setName("Nightly review time").setDesc("Local 24-hour time, for example 22:00.").addText((text) => text.setValue(this.plugin.settings.reviewTime).onChange((value) => {
        void (async () => {
          if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) this.plugin.settings.reviewTime = value;
          await this.plugin.ensureNightlyReviewJob();
          await this.plugin.saveState();
        })();
      }));
    }
    new import_obsidian7.Setting(containerEl).setName("Completion notifications").setDesc("Show an Obsidian notice when an AI job finishes.").addToggle((toggle) => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange((value) => {
      void (async () => {
        this.plugin.settings.notifyOnCompletion = value;
        await this.plugin.saveState();
      })();
    }));
    new import_obsidian7.Setting(containerEl).setName("Run missed jobs after startup").setDesc("Off by default. Enable only if you explicitly want AI work to run after Obsidian was closed.").addToggle((toggle) => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange((value) => {
      void (async () => {
        this.plugin.settings.catchUpOnStart = value;
        await this.plugin.saveState();
        this.display();
      })();
    }));
    if (this.plugin.settings.catchUpOnStart) {
      new import_obsidian7.Setting(containerEl).setName("Startup catch-up window (hours)").setDesc("Only jobs missed within this window will run after startup.").addText((text) => text.setValue(String(this.plugin.settings.catchUpHours)).onChange((value) => {
        void (async () => {
          this.plugin.settings.catchUpHours = Math.max(1, Number.parseInt(value, 10) || 24);
          await this.plugin.saveState();
        })();
      }));
    }
    new import_obsidian7.Setting(containerEl).setName("Schedule notes (optional)").setHeading();
    new import_obsidian7.Setting(containerEl).setName("Keep schedule notes in my vault").setDesc("Off by default. When enabled, every task gets a Markdown note whose frontmatter holds its schedule and prompt \u2014 edit the note or the dashboard, both stay in sync. Task results and history stay in data.json, and turning this off never loses anything.").addToggle((toggle) => toggle.setValue(this.plugin.settings.scheduleNotesEnabled).onChange((value) => {
      void (async () => {
        this.plugin.settings.scheduleNotesEnabled = value;
        await this.plugin.saveState();
        if (value) {
          try {
            const written = await this.plugin.notesSync.syncAll();
            new import_obsidian7.Notice(written ? `Schedule notes created or updated in ${this.plugin.settings.scheduleFolder}.` : "Schedule notes are up to date.");
          } catch (error) {
            new import_obsidian7.Notice(`Could not write schedule notes: ${errorText(error)}`, 8e3);
          }
        }
        this.display();
      })();
    }));
    if (this.plugin.settings.scheduleNotesEnabled) {
      new import_obsidian7.Setting(containerEl).setName("Schedule notes folder").setDesc("Existing notes keep working after a rename of this folder; new notes are created here.").addText((text) => text.setValue(this.plugin.settings.scheduleFolder).onChange((value) => {
        void (async () => {
          this.plugin.settings.scheduleFolder = value.trim() || "AI Schedules";
          await this.plugin.saveState();
        })();
      }));
      new import_obsidian7.Setting(containerEl).setName("Sync notes now").setDesc("Reconcile all task notes with the current schedule, including notes created by hand.").addButton((button) => button.setButtonText("Sync now").onClick(() => {
        void (async () => {
          button.setDisabled(true);
          try {
            const written = await this.plugin.notesSync.syncAll();
            new import_obsidian7.Notice(written ? `${written} note(s) reconciled.` : "All schedule notes are up to date.");
          } catch (error) {
            new import_obsidian7.Notice(`Could not sync schedule notes: ${errorText(error)}`, 8e3);
          }
          button.setDisabled(false);
        })();
      }));
    }
  }
};

// src/notes.ts
var import_obsidian8 = require("obsidian");
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
    return (0, import_obsidian8.normalizePath)(this.plugin.settings.scheduleFolder || "AI Schedules");
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
    let candidate = (0, import_obsidian8.normalizePath)(`${this.folder}/${base}.md`);
    let suffix = 2;
    while (claimed.has(candidate)) {
      candidate = (0, import_obsidian8.normalizePath)(`${this.folder}/${base}-${suffix}.md`);
      suffix += 1;
    }
    return candidate;
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
    const frontmatter = (0, import_obsidian8.stringifyYaml)({ "ai-scheduler": this.definitionFor(job) });
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
${frontmatter}---
${body.join("\n")}`;
  }
  async writeFile(path, content) {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian8.TFile) {
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
          if (!(child instanceof import_obsidian8.TFile) || child.extension !== "md") continue;
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
        if (existing instanceof import_obsidian8.TFile) {
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
      if (job2 && _ScheduleNotesSync.isInside(folder, file.path) && file instanceof import_obsidian8.TFile) {
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
    if (!(file instanceof import_obsidian8.TFile) || file.extension !== "md") return;
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
var AISchedulerPlugin = class extends import_obsidian9.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.jobs = [];
    this.activity = [];
    this.running = false;
    this.reviewRunning = false;
    this.lastTickError = null;
    this.notesSync = new ScheduleNotesSync(this);
    this.runningJobs = /* @__PURE__ */ new Set();
  }
  async onload() {
    const data = await this.loadData();
    const parsed = parseStoredData(data);
    this.settings = parsed.settings;
    this.jobs = parsed.jobs;
    this.activity = parsed.activity;
    const recovered = recoverInterruptedRuns(this.jobs);
    this.assignTaskNumbers();
    this.running = false;
    this.reviewRunning = false;
    this.lastTickError = null;
    this.addRibbonIcon("brain", "Open AI Scheduler", () => new AssistantModal(this.app, this).open());
    this.addCommand({
      id: "open-assistant",
      name: "Open assistant dashboard",
      callback: () => new AssistantModal(this.app, this).open()
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
        new import_obsidian9.Notice("Nightly AI review enabled");
      }
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
    await this.catchUpOnStart();
    if (this.settings.scheduleNotesEnabled) await this.notesSync.syncAll();
  }
  async saveState() {
    await this.saveData({ version: 6, settings: this.settings, jobs: this.jobs, activity: this.activity.slice(-50) });
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
      new import_obsidian9.Notice(`${plan.missed.length} AI task(s) are ready after startup`, 6e3);
    }
    await this.tick();
  }
  async tick() {
    if (this.running) return;
    const due = dueJobs(this.jobs, Date.now());
    if (!due.length) return;
    this.running = true;
    try {
      for (const job of due) {
        if (this.runningJobs.has(job.id)) continue;
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
    }
  }
  async executeJob(job) {
    if (this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id);
    try {
      await this.runJobBody(job);
    } finally {
      this.runningJobs.delete(job.id);
    }
  }
  async runJobBody(job) {
    job.status = "running";
    job.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
    job.attempts = Number(job.attempts || 0) + 1;
    job.runCount = Number(job.runCount || 0) + 1;
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
      job.lastReply = reply || "";
      job.lastStatus = "completed";
      job.lastError = null;
      job.status = "completed";
      await this.processFollowUps(reply, job);
      if (job.output && job.output.folder && reply) {
        await this.writeOutput(job.output.folder, job.output.filename, reply);
      }
      reconcileAfterRun(job);
      this.logActivity("completed", job.title, job.id);
      if (this.settings.notifyOnCompletion && job.notify !== false) new import_obsidian9.Notice(`AI completed: ${job.title}`, 5e3);
    } catch (error) {
      job.status = "failed";
      job.lastStatus = "failed";
      job.lastError = errorText(error);
      reconcileAfterRun(job, { failed: true });
      this.lastTickError = job.lastError;
      this.logActivity("failed", `${job.title}: ${job.lastError}`, job.id);
      new import_obsidian9.Notice(`AI task failed: ${job.title}
${job.lastError}`, 8e3);
    }
    await this.saveState();
  }
  async handleVaultChange(file) {
    if (!file || !file.path || this.running) return;
    const eventJobs = this.jobs.filter((job) => job.enabled && job.schedule && job.schedule.kind === "event" && (!job.schedule.event || job.schedule.event === "modify" || job.schedule.event === "vault-change"));
    if (!eventJobs.length) return;
    const now = Date.now();
    for (const job of eventJobs) {
      const cooldown = Number(job.cooldownMinutes || 10) * 6e4;
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
      if (!job.nextRunAt || new Date(job.nextRunAt) <= /* @__PURE__ */ new Date()) job.nextRunAt = nextDailyRun(this.settings.reviewTime);
    }
  }
  async startReviewRun(manual = true, kind = "daily") {
    if (this.reviewRunning) {
      new import_obsidian9.Notice("A review is already running. You can keep using Obsidian while it finishes.", 5e3);
      return;
    }
    this.reviewRunning = true;
    new import_obsidian9.Notice(`${kind === "nightly" ? "Nightly" : "Daily"} review started. It will create ${this.settings.reportFolder}/${localTimestampKey()}.md. You can keep using Obsidian.`, 7e3);
    void this.runDailyReview(manual, null, kind).catch((error) => {
      this.logActivity("failed", `Review failed: ${errorText(error)}`);
      new import_obsidian9.Notice(`Review failed: ${errorText(error)}`, 8e3);
      void this.saveState();
    }).finally(() => {
      this.reviewRunning = false;
    });
  }
  async runDailyReview(manual, execution = null, kind = "daily") {
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
    while (this.app.vault.getAbstractFileByPath((0, import_obsidian9.normalizePath)(`${this.settings.reportFolder}/${filename}`))) {
      filename = `${timestamp}-${suffix}.md`;
      suffix += 1;
    }
    const path = `${this.settings.reportFolder}/${filename}`;
    await this.writeOutput(this.settings.reportFolder, filename, `# ${reportTitle} - ${today}

Generated: ${formatDate(now.toISOString())}

${report}`);
    this.logActivity("review", `Daily review written to ${path}`);
    if (manual || this.settings.notifyOnCompletion) new import_obsidian9.Notice(`Review written to ${path}`, 6e3);
    await this.saveState();
    return report;
  }
  includeReviewFile(file, start) {
    if (!file || !file.path || file.path.startsWith(`${this.settings.reportFolder}/`)) return false;
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
  getJobContext(job) {
    const context = getPathsContext(this.app, job && job.contextPaths);
    if (context.missingPaths.length) throw new Error(`Selected context no longer exists: ${context.missingPaths.join(", ")}`);
    return context;
  }
  async writeOutput(folder, filename, content) {
    const cleanFolder = (0, import_obsidian9.normalizePath)(String(folder || "").replace(/^\/+|\/+$/g, ""));
    const cleanName = String(filename || `${localDateKey()}.md`).replace(/[\\/]/g, "-");
    const path = (0, import_obsidian9.normalizePath)(cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName);
    await this.ensureFolder(cleanFolder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian9.TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
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
  async processFollowUps(reply, parentJob) {
    const plans = extractJson(reply).filter((item) => item && item.title && item.prompt && item.schedule);
    for (const plan of plans.slice(0, 3)) {
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
    return {
      title: String(plan.title).slice(0, 120),
      prompt: String(plan.prompt),
      tab: Number(planRecord.tab || fallbackTab || this.settings.assistantTab),
      profile: planRecord.profile || null,
      conversationId: planRecord.conversationId || null,
      providerId: planRecord.providerId || null,
      model: planRecord.model || null,
      schedule: normalized,
      nextRunAt: normalized.kind === "event" ? null : getScheduleNextRun(normalized),
      output: planRecord.output || null,
      notify: planRecord.notify !== false,
      contextPaths: Array.isArray(planRecord.contextPaths) ? planRecord.contextPaths : Array.isArray(context == null ? void 0 : context.paths) ? context.paths : [],
      cooldownMinutes: planRecord.cooldownMinutes || schedule.cooldownMinutes,
      source
    };
  }
  async planAndCreate(goal, contextPaths = [], resultFolder = "") {
    const execution = await resolveModel(this, this.settings.planningModel, "AI planning");
    const prompt = plannerPrompt(goal, contextPaths);
    const context = getPathsContext(this.app, contextPaths);
    const reply = await sendToAI(this, prompt, execution, context);
    const plans = extractJson(reply).filter((item) => item && item.title && item.prompt && item.schedule);
    if (!plans.length) throw new Error("The AI returned no valid schedule. Ask it for a concrete time or cadence.");
    const jobs = [];
    for (const plan of plans.slice(0, 10)) {
      const planRecord = plan;
      jobs.push(await this.addJob(Object.assign(
        this.jobFromPlan(Object.assign({}, plan, {
          contextPaths: planRecord.contextPaths || planRecord.context && planRecord.context.paths || contextPaths,
          output: planRecord.output || (resultFolder ? { folder: resultFolder } : null)
        }), execution.tab, "planner"),
        { profile: execution.modelRef, conversationId: execution.conversationId, providerId: execution.providerId, model: execution.model }
      )));
    }
    this.logActivity("planned", `AI created ${jobs.length} job(s)`);
    await this.saveState();
    return { reply, jobs };
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
  async resolveModel(value, action) {
    return resolveModel(this, value, action);
  }
  testNotification() {
    new import_obsidian9.Notice("AI Scheduler notifications are working.");
    this.logActivity("notification", "Test notification sent");
    void this.saveState();
  }
  async deleteJob(job) {
    this.jobs = this.jobs.filter((candidate) => candidate.id !== job.id);
    this.logActivity("deleted", `Deleted ${job.title}`, job.id);
    await this.saveState();
  }
  async disableAllJobs() {
    for (const job of this.jobs.filter((candidate) => !isNightlyReviewJob(candidate) && candidate.enabled)) {
      job.enabled = false;
      job.nextRunAt = null;
      job.status = "disabled";
      job.lastStatus = "disabled";
    }
    await this.saveState();
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
    for (const job of this.jobs.filter((candidate) => !isNightlyReviewJob(candidate) && isDisabledTask(candidate))) {
      job.enabled = true;
      job.status = "scheduled";
      job.lastStatus = null;
      job.lastError = null;
      rescheduleEnabledJob(job);
    }
    await this.saveState();
  }
  async deleteAllJobs() {
    this.jobs = this.jobs.filter((job) => isNightlyReviewJob(job));
    this.logActivity("deleted", "Deleted all scheduled tasks");
    await this.saveState();
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
};
