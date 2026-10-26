// Creates/upgrades vivo PC Suite's local databases exactly like vivoSyncService.exe does at startup
// (schemas, seed rows and column migrations recovered from the Windows binary into sync-schema.json).
// Run with:  ELECTRON_RUN_AS_NODE=1 electron db-init.js <sqlite3 .node> <database dir>
'use strict';
const fs = require('fs'), path = require('path');
const [binPath, dir] = process.argv.slice(2);
const sqlite = require(binPath);
for (const C of [sqlite.Database, sqlite.Statement]) if (!C.prototype.emit) C.prototype.emit = function () {};  // normally added by sqlite3's JS wrapper
const schema = require('./sync-schema.json');
fs.mkdirSync(dir, { recursive: true });
const root = path.dirname(dir);

const open = f => new Promise((res, rej) => { const db = new sqlite.Database(f, 6, e => e ? rej(e) : res(db)); });
const exec = (db, sql) => new Promise(res => db.exec(sql, e => res(e)));
const close = db => new Promise(res => db.close(() => res()));

(async () => {
  for (const [name, { create, columns }] of Object.entries(schema)) {
    const file = path.join(dir, name);
    const fresh = !fs.existsSync(file);
    const db = await open(file);
    for (const sql of create) {
      // like the service: plain CREATE / seed INSERTs only on a new database; IF NOT EXISTS always
      if (!fresh && !/if not exists|^insert .* where not exists/i.test(sql)) continue;
      const e = await exec(db, sql);
      if (e && !/already exists/.test(e.message)) console.error(`${name}: ${e.message} :: ${sql.slice(0, 80)}`);
    }
    for (const [t, c, type, def] of columns) {
      const e = await exec(db, `alter table ${t} add column ${c} ${type} default ${def};`);
      if (e && !/duplicate column|no such table/.test(e.message)) console.error(`${name}: ${e.message}`);
    }
    if (name === 'Config.db') {
      const q = s => s.replace(/'/g, "''");
      await exec(db, 'insert into Config (version) select 0 where not exists(select 1 from Config);');
      await exec(db, `insert into SoftwareSet (openId, configDir, storageDir, notifyOn, updateOn, otherCalendar, calendarWeekStartDate, timeZoneOn) ` +
        `select 'visitor', '${q(path.join(root, 'database'))}', '${q(path.join(root, 'data'))}', 1, 1, 1, 0, 0 where not exists(select 1 from SoftwareSet);`);
    }
    await close(db);
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
