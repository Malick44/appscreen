import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDatabase,migrate,verifyMigrations } from './db.js';
import { createApp } from './app.js';
import { createWorker } from './worker.js';
const config=loadConfig(),db=createDatabase(config.databaseUrl);await (config.production?verifyMigrations(db):migrate(db));
const {app,services,billing}=await createApp(config,db);
await app.listen({host:config.host,port:config.port});
const worker=config.embeddedWorker?createWorker(services,billing):null;if(worker)await worker.start();
console.log(`AppScreen SaaS ready at ${config.baseUrl}${config.developmentAuth?' (localhost development accounts only)':''}`);
let closing=false;async function shutdown(){if(closing)return;closing=true;if(worker)await worker.stop();await app.close();await db.end();}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
