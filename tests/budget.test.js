'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Budget, LIMIT, ALLOCATION, FILE_NAME, LOCK_NAME, MARKER_NAME } = require('../server/budget');

function fixture(t, start = '2026-09-30T12:00:00Z') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-budget-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = { now: Date.parse(start) };
  return { directory, clock, budget: new Budget(directory, { now: () => clock.now }) };
}

test('fixed independent lanes sum to a hard 100-post UTC daily allowance', (t) => {
  const { budget } = fixture(t);
  assert.equal(LIMIT, 100);
  assert.equal(budget.remaining(), 100);
  for (const [lane, limit] of Object.entries(ALLOCATION)) {
    const reservation = budget.reserve(lane, 1000);
    assert.equal(reservation.count, limit);
    assert.equal(budget.remaining(lane), 0);
    assert.equal(budget.reserve(lane, 1), null);
    assert.equal(budget.settle(reservation, limit), true);
  }
  assert.equal(budget.snapshot().used, 100);
  assert.equal(budget.snapshot().remaining, 0);
  assert.deepEqual(budget.snapshot().pending, []);
});

test('reserves largest allowed count, enforces endpoint minima, and never steals lanes', (t) => {
  const { budget } = fixture(t);
  const first = budget.reserve('broad', 23, 10);
  assert.equal(first.count, 23);
  assert.equal(budget.reserve('broad', 10, 10), null);
  assert.equal(budget.remaining('broad'), 7);
  assert.equal(budget.remaining('watch'), 10);
  const partial = budget.reserve('broad', 10, 5);
  assert.equal(partial.count, 7);
  assert.equal(budget.reserve('broad', 1), null);
  assert.equal(budget.reserve('watch', 3, 5), null);
  assert.equal(budget.reserve('watch', 0), null);
  assert.throws(() => budget.reserve('invalid', 1), TypeError);
  assert.throws(() => budget.reserve('flex', 1.5), TypeError);
  assert.throws(() => budget.reserve('flex', 10, 0), TypeError);
  assert.throws(() => budget.reserve('flex', Infinity), TypeError);
  assert.throws(() => budget.remaining('invalid'), TypeError);
});

test('debits are durable before return; verified settlement refunds only unused posts', (t) => {
  const { budget, directory, clock } = fixture(t);
  const reservation = budget.reserve('broad', 20);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8'));
  assert.equal(saved.used.broad, 20);
  assert.equal(saved.pending[0].id, reservation.id);
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), false);
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.remaining('broad'), 10);
  assert.equal(restarted.settle(reservation, 7), true);
  assert.equal(budget.remaining('broad'), 23);
  assert.equal(restarted.settle(reservation, 0), false);
  assert.equal(budget.remaining('broad'), 23);
  assert.equal(budget.snapshot().used, 7);
});

test('uncertain calls preserve their full debit across restarts', (t) => {
  const { budget, directory, clock } = fixture(t);
  const reservation = budget.reserve('watch', 10);
  assert.throws(() => budget.settle(reservation, undefined), TypeError);
  assert.throws(() => budget.settle(reservation, -1), TypeError);
  assert.throws(() => budget.settle(reservation, 1.5), TypeError);
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.reserve('watch', 1), null);
  assert.equal(restarted.snapshot().used, 10);
  assert.equal(restarted.snapshot().pending.length, 1);
  // A fully verified empty success/error can explicitly release the reservation.
  assert.equal(restarted.settle(reservation, 0), true);
  assert.equal(restarted.remaining('watch'), 10);
});

test('forged, altered, or already settled reservation objects cannot refund quota', (t) => {
  const { budget } = fixture(t);
  const reservation = budget.reserve('flex', 10);
  assert.equal(budget.settle({ ...reservation, count: 9 }, 0), false);
  assert.equal(budget.settle({ ...reservation, day: '2026-09-29' }, 0), false);
  assert.equal(budget.settle({ ...reservation, lane: 'watch' }, 0), false);
  assert.equal(budget.settle({ ...reservation, id: 'unknown' }, 0), false);
  assert.equal(budget.settle(null, 0), false);
  assert.equal(budget.remaining('flex'), 0);
  assert.equal(budget.settle(reservation, 10), true);
  assert.equal(budget.settle(reservation, 0), false);
  assert.equal(budget.remaining('flex'), 0);
});

test('UTC midnight resets settled quota, independently of local daylight saving time', (t) => {
  const { budget, clock } = fixture(t, '2026-11-01T23:59:59.999Z');
  const reservation = budget.reserve('broad', 30);
  assert.equal(budget.settle(reservation, 30), true);
  assert.equal(budget.remaining('broad'), 0);
  clock.now += 1;
  assert.equal(budget.remaining('broad'), 30);
  assert.equal(budget.snapshot().day, '2026-11-02');
  assert.equal(budget.snapshot().used, 0);
});

test('in-flight previous-day requests block all new lanes; late raw results debit response day', (t) => {
  const { budget, clock, directory } = fixture(t, '2026-09-30T23:59:59Z');
  const first = budget.reserve('broad', 20);
  const second = budget.reserve('broad', 10);
  const watched = budget.reserve('watch', 10);
  clock.now += 2000;
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.remaining(), 0);
  assert.equal(restarted.snapshot().reason, 'unresolved_previous_day');
  assert.equal(restarted.reserve('flex', 1), null);
  assert.equal(restarted.settle(first, 15), true);
  assert.equal(restarted.reserve('broad', 1), null);
  assert.equal(restarted.settle(second, 5), true);
  assert.equal(restarted.remaining(), 0);
  assert.equal(restarted.settle(watched, 8), true);
  assert.equal(restarted.snapshot().used, 28);
  assert.equal(restarted.remaining('broad'), 10);
  assert.equal(restarted.remaining('watch'), 2);
  assert.equal(restarted.remaining(), 72);
  for (const lane of Object.keys(ALLOCATION)) {
    const reservation = restarted.reserve(lane, 100);
    if (reservation) assert.equal(restarted.settle(reservation, reservation.count), true);
  }
  assert.equal(restarted.snapshot().used, 100);
  assert.equal(restarted.remaining(), 0);
});

test('a crashed unresolved call conservatively blocks successive UTC days until reconciled', (t) => {
  const { budget, clock, directory } = fixture(t);
  const reservation = budget.reserve('baseline', 10);
  clock.now += 86400000 * 7;
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.reserve('broad', 10), null);
  assert.equal(restarted.snapshot().reason, 'unresolved_previous_day');
  assert.equal(restarted.snapshot().pending[0].day, '2026-09-30');
  clock.now += 86400000;
  assert.equal(restarted.reserve('watch', 1), null);
  assert.equal(restarted.settle(reservation, 6), true);
  assert.equal(restarted.snapshot().used, 6);
  assert.equal(restarted.remaining(), 94);
});

test('a backwards clock fails closed without corrupting the ledger', (t) => {
  const { budget, clock } = fixture(t);
  const reservation = budget.reserve('flex', 10);
  clock.now -= 86400000;
  assert.equal(budget.reserve('broad', 10), null);
  assert.equal(budget.snapshot().reason, 'clock_rollback');
  assert.equal(budget.settle(reservation, 0), false);
  clock.now += 86400000;
  assert.equal(budget.remaining('flex'), 0);
  assert.equal(budget.settle(reservation, 10), true);
});

test('over-return is recorded at actual cost and permanently halts all lanes and later days', (t) => {
  const { budget, clock, directory } = fixture(t);
  const reservation = budget.reserve('broad', 10);
  assert.throws(() => budget.settle(reservation, 12), { code: 'api_over_return' });
  assert.equal(budget.snapshot().used, 12);
  assert.equal(budget.snapshot().halted.rawCount, 12);
  assert.equal(budget.snapshot().reason, 'api_over_return');
  assert.equal(budget.reserve('watch', 1), null);
  clock.now += 86400000;
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.remaining(), 0);
  assert.equal(restarted.snapshot().reason, 'api_over_return');
});

test('an over-return beyond a lane or total cap is persisted rather than reset on reload', (t) => {
  const { budget, directory, clock } = fixture(t);
  const reservation = budget.reserve('broad', 30);
  assert.throws(() => budget.settle(reservation, 101), { code: 'api_over_return' });
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.snapshot().used, 101);
  assert.equal(restarted.snapshot().reason, 'api_over_return');
});

test('existing and very old lock directories are never stolen', (t) => {
  const { budget, directory } = fixture(t);
  budget.snapshot();
  const before = fs.readFileSync(path.join(directory, FILE_NAME), 'utf8');
  const lock = path.join(directory, LOCK_NAME);
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(budget.reserve('broad', 10), null);
  assert.equal(budget.remaining('watch'), 0);
  assert.equal(budget.snapshot().reason, 'locked');
  assert.equal(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8'), before);
  assert.equal(fs.statSync(lock).mtimeMs, 0);
});

test('corrupt JSON, invalid counters, duplicate reservations, and missing initialized ledgers fail closed', async (t) => {
  const cases = {
    'corrupt JSON': () => '{',
    'invalid allocation': (state) => JSON.stringify({ ...state, used: { ...state.used, broad: 31 } }),
    'negative used': (state) => JSON.stringify({ ...state, used: { ...state.used, broad: -1 } }),
    'duplicate reservation': (state) => JSON.stringify({ ...state, pending: [...state.pending, state.pending[0]] }),
    'pending debit missing': (state) => JSON.stringify({ ...state, used: { ...state.used, broad: 0 } }),
    'missing ledger': () => null,
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, (t) => {
    const { budget, directory, clock } = fixture(t);
    budget.reserve('broad', 10);
    const file = path.join(directory, FILE_NAME);
    const bad = corrupt(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (bad === null) fs.unlinkSync(file); else fs.writeFileSync(file, bad);
    const restarted = new Budget(directory, { now: () => clock.now });
    assert.equal(restarted.reserve('watch', 10), null);
    assert.equal(restarted.remaining(), 0);
    assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
    if (bad !== null) assert.equal(fs.readFileSync(file, 'utf8'), bad);
  });
});

test('marker inconsistencies cannot silently initialize a fresh quota', async (t) => {
  for (const kind of ['missing marker', 'corrupt marker', 'only marker']) await t.test(kind, (t) => {
    const { budget, directory, clock } = fixture(t);
    budget.reserve('broad', 10);
    const marker = path.join(directory, MARKER_NAME);
    if (kind === 'missing marker') fs.unlinkSync(marker);
    if (kind === 'corrupt marker') fs.writeFileSync(marker, 'bad marker');
    if (kind === 'only marker') fs.unlinkSync(path.join(directory, FILE_NAME));
    const restarted = new Budget(directory, { now: () => clock.now });
    assert.equal(restarted.reserve('broad', 30), null);
    assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
  });
});

test('snapshots cannot mutate the stored reservations or allocations', (t) => {
  const { budget } = fixture(t);
  const reservation = budget.reserve('broad', 10);
  const snapshot = budget.snapshot();
  snapshot.pending[0].count = 1;
  snapshot.lanes.broad.used = 0;
  reservation.count = 1;
  assert.equal(budget.snapshot().pending[0].count, 10);
  assert.equal(budget.remaining('broad'), 20);
});

function runChild(script, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...arguments_], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`Child ${code}: ${stderr}`)));
  });
}

test('independent concurrent processes cannot reserve more than 100 total or steal lanes', { timeout: 30000 }, async (t) => {
  const { directory, budget } = fixture(t);
  const script = `
    const { Budget, ALLOCATION } = require(process.argv[1]);
    const budget = new Budget(process.argv[2], { now: () => Date.parse('2026-09-30T12:00:00Z') });
    const lanes = Object.keys(ALLOCATION);
    const counts = Object.fromEntries(lanes.map((lane) => [lane, 0]));
    (async () => {
      for (let i = 0; i < 200; i++) {
        const lane = lanes[i % lanes.length];
        const reservation = budget.reserve(lane, 1);
        if (reservation) {
          counts[lane] += reservation.count;
          // Leave the reservation debited just as a killed process would.
        } else await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write(JSON.stringify(counts));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(script, [require.resolve('../server/budget'), directory])));
  const totals = Object.fromEntries(Object.keys(ALLOCATION).map((lane) => [lane, results.reduce((sum, counts) => sum + counts[lane], 0)]));
  assert.deepEqual(totals, { ...ALLOCATION });
  assert.equal(Object.values(totals).reduce((sum, count) => sum + count, 0), 100);
  assert.equal(budget.snapshot().used, 100);
  assert.equal(budget.snapshot().pending.length, 100);
  assert.equal(budget.remaining(), 0);
});

test('failed atomic replacement or post-rename fsync withholds reservation and retains the lock', async (t) => {
  for (const failure of ['rename', 'fsync-after-rename']) await t.test(failure, async (t) => {
    const { directory, budget } = fixture(t);
    assert.equal(budget.remaining(), 100);
    const script = `
      const fs = require('node:fs');
      const { Budget } = require(process.argv[1]);
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      let renamed = false;
      fs.renameSync = (...args) => {
        if (process.argv[3] === 'rename') throw new Error('simulated failed rename');
        rename(...args);
        renamed = true;
      };
      fs.fsyncSync = (...args) => {
        if (renamed) throw new Error('simulated post-rename fsync failure');
        return sync(...args);
      };
      const budget = new Budget(process.argv[2], { now: () => Date.parse('2026-09-30T12:00:00Z') });
      process.stdout.write(JSON.stringify({ reservation: budget.reserve('broad', 10) }));
    `;
    const result = await runChild(script, [require.resolve('../server/budget'), directory, failure]);
    assert.equal(result.reservation, null);
    assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
    assert.equal(budget.remaining(), 0);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8'));
    assert.equal(saved.used.broad, failure === 'rename' ? 0 : 10);
    assert.equal(saved.pending.length, failure === 'rename' ? 0 : 1);
  });
});

test('a process killed during reservation leaves a lock that another process cannot reuse', async (t) => {
  const { directory, budget } = fixture(t);
  budget.snapshot();
  const script = `
    const fs = require('node:fs');
    const { Budget } = require(process.argv[1]);
    fs.renameSync = () => { process.stdout.write(JSON.stringify({ interrupted: true })); process.exit(0); };
    const budget = new Budget(process.argv[2], { now: () => Date.parse('2026-09-30T12:00:00Z') });
    budget.reserve('broad', 10);
  `;
  assert.deepEqual(await runChild(script, [require.resolve('../server/budget'), directory]), { interrupted: true });
  assert.equal(fs.existsSync(path.join(directory, LOCK_NAME)), true);
  assert.equal(budget.reserve('watch', 10), null);
  assert.equal(budget.snapshot().reason, 'locked');
});

test('previous-day over-return records the response-day debit and halts', (t) => {
  const { budget, clock } = fixture(t, '2026-09-30T23:59:59Z');
  const reservation = budget.reserve('watch', 10);
  clock.now += 2000;
  assert.throws(() => budget.settle(reservation, 11), { code: 'api_over_return' });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.day, '2026-10-01');
  assert.equal(snapshot.used, 11);
  assert.equal(snapshot.halted.day, '2026-10-01');
  assert.equal(snapshot.remaining, 0);
});

test('migration initializes an unknown prior-use day fully exhausted, then resets at UTC midnight', (t) => {
  const { directory, clock } = fixture(t, '2026-09-30T23:59:59.999Z');
  const budget = new Budget(directory, { now: () => clock.now, initializeExhausted: true });
  const snapshot = budget.snapshot();
  assert.equal(snapshot.used, 100);
  assert.equal(snapshot.remaining, 0);
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.reason, 'migration_day_exhausted');
  assert.equal(snapshot.bootstrapDay, '2026-09-30');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8')).used, { ...ALLOCATION });
  for (const lane of Object.keys(ALLOCATION)) assert.equal(budget.reserve(lane, 1), null);
  const restarted = new Budget(directory, { now: () => clock.now });
  assert.equal(restarted.snapshot().reason, 'migration_day_exhausted');
  clock.now++;
  assert.equal(restarted.snapshot().blocked, false);
  assert.equal(restarted.snapshot().reason, null);
  assert.equal(restarted.remaining(), 100);
  assert.equal(restarted.reserve('broad', 10).count, 10);
});

test('migration initialization option never alters an existing normal or migrated ledger', (t) => {
  const { budget, directory, clock } = fixture(t);
  const reservation = budget.reserve('broad', 10);
  const before = fs.readFileSync(path.join(directory, FILE_NAME), 'utf8');
  const restarted = new Budget(directory, { now: () => clock.now, initializeExhausted: true });
  assert.equal(restarted.remaining(), 90);
  assert.equal(restarted.snapshot().bootstrapDay, undefined);
  assert.equal(fs.readFileSync(path.join(directory, FILE_NAME), 'utf8'), before);
  assert.equal(restarted.settle(reservation, 10), true);
  clock.now += 86400000;
  assert.equal(restarted.remaining(), 100);
  assert.equal(restarted.snapshot().reason, null);
});

test('invalid or future migration bootstrap dates fail closed', async (t) => {
  for (const bootstrapDay of ['bad-date', '2026-02-30', '2026-10-01', null]) await t.test(String(bootstrapDay), (t) => {
    const { budget, directory } = fixture(t);
    budget.snapshot();
    const file = path.join(directory, FILE_NAME);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...state, bootstrapDay }));
    assert.equal(budget.reserve('broad', 10), null);
    assert.equal(budget.remaining(), 0);
  });
});
