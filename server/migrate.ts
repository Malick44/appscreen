import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDatabase, migrate } from './db.js';
const db = createDatabase(loadConfig().databaseUrl);
try { await migrate(db); console.log('AppScreen database migrations applied.'); }
finally { await db.end(); }
