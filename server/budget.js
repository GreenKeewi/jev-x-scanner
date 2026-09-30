'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMIT = 100;
const ALLOCATION = Object.freeze({ broad: 30, watch: 10, first_refresh: 40, baseline: 10, flex: 10 });
const LANES = Object.keys(ALLOCATION);
const FILE_NAME = 'x-budget.json';
const LOCK_NAME = 'x-budget.lock';
const MARKER_NAME = 'x-budget.initialized';
const MARKER = 'x-post-budget-v1\n';

function counters() { return Object.fromEntries(LANES.map((lane) => [lane, 0])); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * A deliberately conservative, synchronous cross-process X post budget.
 *
 * All callers must share this data directory on a filesystem with POSIX atomic
 * mkdir/rename and fsync semantics. A reservation MUST be persisted before any
 * request, and the request's result limit MUST be <= reservation.count. Count
 * every raw returned post, including filtered/duplicate posts and expansions.
 * settle() is only for a fully parsed, verified response. Network failures,
 * malformed/partial responses and crashes leave the full debit outstanding.
 *
 * At UTC rollover, older in-flight reservations block ALL new calls. A verified
 * late response is additionally charged to its response day. Unknown responses
 * can therefore block future days indefinitely, intentionally. This prevents a
 * slow yesterday request plus today's fresh quota from exceeding today's cap.
 * A backwards clock also fails closed. An API over-return permanently halts the
 * ledger after recording its actual debit (software cannot undo returned posts).
 *
 * Recovery is manual: stop every process using the directory, establish from X
 * records that no request can still return, and reconcile the ledger's actual
 * daily counts/reservations before restarting. Never delete the ledger/marker
 * to reset quota; never automatically steal a lock based on age or process IDs.
 * A leftover lock means a write/process outcome is uncertain. Preserve evidence
 * and reconcile it before manually removing the lock with all processes stopped.
 */
class Budget {
  constructor(dataDir, { now = Date.now, initializeExhausted = false } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('A budget data directory is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof initializeExhausted !== 'boolean') throw new TypeError('initializeExhausted must be a boolean');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, FILE_NAME);
    this.lock = path.join(this.dataDir, LOCK_NAME);
    this.marker = path.join(this.dataDir, MARKER_NAME);
    this.now = now;
    this.initializeExhausted = initializeExhausted;
    this.lastError = null;
  }

  _day() {
    const date = new Date(this.now());
    if (!Number.isFinite(date.getTime())) throw fail('invalid_clock', 'The budget clock is invalid');
    const day = date.toISOString().slice(0, 10);
    if (!validDay(day)) throw fail('invalid_clock', 'The budget clock is outside supported UTC dates');
    return day;
  }

  _validate(state) {
    const invalid = () => { throw fail('invalid_ledger', 'The durable X budget ledger is invalid'); };
    if (!isRecord(state) || state.version !== 1 || !validDay(state.day) || !isRecord(state.used) ||
        Object.keys(state.used).length !== LANES.length || !Array.isArray(state.pending) ||
        (state.bootstrapDay !== undefined && (!validDay(state.bootstrapDay) || state.bootstrapDay > state.day)) ||
        !(state.halted === null || (isRecord(state.halted) && state.halted.code === 'api_over_return' &&
          validDay(state.halted.day) && typeof state.halted.id === 'string' &&
          integer(state.halted.rawCount) && integer(state.halted.reserved) &&
          state.halted.rawCount > state.halted.reserved))) invalid();
    for (const lane of LANES) if (!integer(state.used[lane])) invalid();
    const currentPending = counters();
    const olderPending = counters();
    const ids = new Set();
    for (const reservation of state.pending) {
      if (!isRecord(reservation) || typeof reservation.id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(reservation.id) || ids.has(reservation.id) ||
          !validDay(reservation.day) || reservation.day > state.day ||
          !Object.hasOwn(ALLOCATION, reservation.lane) || !integer(reservation.count) ||
          reservation.count < 1 || reservation.count > ALLOCATION[reservation.lane]) invalid();
      ids.add(reservation.id);
      (reservation.day === state.day ? currentPending : olderPending)[reservation.lane] += reservation.count;
    }
    for (const lane of LANES) {
      if (currentPending[lane] > state.used[lane]) invalid();
      if (!state.halted && (state.used[lane] + olderPending[lane] > ALLOCATION[lane])) invalid();
    }
  }

  _read(day) {
    let marked = false;
    try {
      const stat = fs.lstatSync(this.marker);
      if (!stat.isFile() || fs.readFileSync(this.marker, 'utf8') !== MARKER) {
        throw fail('invalid_ledger', 'The budget initialization marker is invalid');
      }
      marked = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    try {
      if (!fs.lstatSync(this.file).isFile()) throw fail('invalid_ledger', 'The budget ledger is not a regular file');
      if (!marked) throw fail('invalid_ledger', 'The budget ledger has no initialization marker');
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (marked) throw fail('missing_ledger', 'An initialized X budget ledger is missing');
      // Marker first: a crash at any point in initialization cannot create a
      // silently fresh ledger after previous reservations might have existed.
      const fd = fs.openSync(this.marker, 'wx', 0o600);
      try { fs.writeFileSync(fd, MARKER); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(this.dataDir);
      // An existing pre-budget deployment may already have returned an unknown
      // number of posts today. Exhaust its first day instead of issuing another
      // fresh 100. This option never changes a ledger that already exists.
      state = {
        version: 1, day, used: this.initializeExhausted ? { ...ALLOCATION } : counters(),
        pending: [], halted: null, ...(this.initializeExhausted ? { bootstrapDay: day } : {}),
      };
      this._write(state);
    }
    this._validate(state);
    return state;
  }

  _write(state) {
    this._validate(state);
    const temporary = path.join(this.dataDir, `${FILE_NAME}.${crypto.randomUUID()}.tmp`);
    // Leave an uncertain temp file and the exclusive lock for diagnosis if any
    // storage operation fails. Never turn a failed write into fresh allowance.
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    syncDirectory(this.dataDir);
  }

  _transaction(action, fallback) {
    try {
      const firstCreated = fs.mkdirSync(this.dataDir, { recursive: true });
      // Make every newly created parent link durable before storing the ledger.
      if (firstCreated) {
        let directory = this.dataDir;
        while (directory.startsWith(firstCreated)) {
          syncDirectory(path.dirname(directory));
          if (directory === firstCreated) break;
          directory = path.dirname(directory);
        }
      }
      try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('locked', 'X budget is locked by another or interrupted process');
        throw error;
      }
      syncDirectory(this.dataDir);
      const day = this._day();
      const state = this._read(day);
      let value;
      if (day < state.day) {
        this.lastError = { code: 'clock_rollback', message: 'The UTC clock is older than the durable budget day' };
        value = fallback(this.lastError);
      } else {
        if (day > state.day && !state.halted) {
          state.day = day;
          state.used = counters();
          this._write(state);
        }
        value = action(state, day);
        this.lastError = null;
      }
      fs.rmdirSync(this.lock);
      syncDirectory(this.dataDir);
      return value;
    } catch (error) {
      // Keep our acquired lock on invalid data or uncertain persistence. Other
      // processes must also stop; an instance-local error flag is insufficient.
      this.lastError = {
        code: error.code || 'invalid_ledger',
        message: error.code === 'locked' ? error.message : 'X budget unavailable; inspect its durable ledger and lock',
      };
      return fallback(this.lastError);
    }
  }

  reserve(lane, requested, min = 1) {
    if (!Object.hasOwn(ALLOCATION, lane)) throw new TypeError(`Unknown budget lane: ${lane}`);
    if (!integer(requested) || !integer(min) || min < 1) throw new TypeError('Reservation limits must be nonnegative integers; min must be positive');
    return this._transaction((state) => {
      if (state.halted || state.bootstrapDay === state.day || state.pending.some((entry) => entry.day < state.day)) return null;
      const count = Math.min(requested, ALLOCATION[lane] - state.used[lane]);
      if (count < min) return null;
      const reservation = { id: crypto.randomUUID(), day: state.day, lane, count };
      state.used[lane] += count;
      state.pending.push(reservation);
      this._write(state);
      return { ...reservation };
    }, () => null);
  }

  settle(reservation, rawCount) {
    if (!integer(rawCount)) throw new TypeError('rawCount must be a verified nonnegative integer');
    if (!isRecord(reservation) || typeof reservation.id !== 'string') return false;
    let overReturn = false;
    const settled = this._transaction((state, day) => {
      if (state.halted) return false;
      const index = state.pending.findIndex((entry) => entry.id === reservation.id);
      if (index < 0) return false; // Unknown/already-settled reservations never refund twice.
      const saved = state.pending[index];
      if (saved.day !== reservation.day || saved.count !== reservation.count ||
          (reservation.lane !== undefined && saved.lane !== reservation.lane)) return false;
      // The previous day was already debited before the request. Also debit the
      // response day when different. This intentionally counts a late call twice.
      state.used[saved.lane] += saved.day === day ? rawCount - saved.count : rawCount;
      state.pending.splice(index, 1);
      overReturn = rawCount > saved.count;
      if (overReturn) {
        state.halted = { code: 'api_over_return', day, id: saved.id, reserved: saved.count, rawCount };
      }
      this._write(state);
      return true;
    }, () => false);
    if (overReturn) throw fail('api_over_return', 'X returned more posts than reserved; the durable budget is halted');
    return settled;
  }

  remaining(lane) {
    if (lane !== undefined && !Object.hasOwn(ALLOCATION, lane)) throw new TypeError(`Unknown budget lane: ${lane}`);
    const snapshot = this.snapshot();
    return lane === undefined ? snapshot.remaining : snapshot.lanes[lane].remaining;
  }

  snapshot() {
    return this._transaction((state) => {
      const olderPending = state.pending.filter((entry) => entry.day < state.day);
      const reason = state.halted ? state.halted.code : olderPending.length ? 'unresolved_previous_day' :
        state.bootstrapDay === state.day ? 'migration_day_exhausted' : null;
      const lanes = Object.fromEntries(LANES.map((lane) => [lane, {
        limit: ALLOCATION[lane], used: state.used[lane],
        remaining: reason ? 0 : Math.max(0, ALLOCATION[lane] - state.used[lane]),
        pending: state.pending.filter((entry) => entry.lane === lane).reduce((sum, entry) => sum + entry.count, 0),
      }]));
      return {
        day: state.day, limit: LIMIT, used: LANES.reduce((sum, lane) => sum + state.used[lane], 0),
        remaining: LANES.reduce((sum, lane) => sum + lanes[lane].remaining, 0),
        blocked: !!reason, reason, lanes,
        ...(state.bootstrapDay ? { bootstrapDay: state.bootstrapDay } : {}),
        pending: state.pending.map((entry) => ({ ...entry })),
        halted: state.halted ? { ...state.halted } : null,
      };
    }, (error) => ({
      day: null, limit: LIMIT, used: null, remaining: 0, blocked: true, reason: error.code,
      lanes: Object.fromEntries(LANES.map((lane) => [lane, { limit: ALLOCATION[lane], used: null, remaining: 0, pending: null }])),
      pending: [], halted: null,
    }));
  }
}

module.exports = { Budget, LIMIT, ALLOCATION, FILE_NAME, LOCK_NAME, MARKER_NAME };
