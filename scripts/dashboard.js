// Öffnet das Dashboard erneut im Browser (mit Zugangs-Token).
import { configExists, loadConfig } from '../src/config.js';
import path from 'node:path';
import { openDashboard } from '../src/util.js';
import { DATA } from '../src/config.js';

if (!configExists()) { console.error('Noch nicht eingerichtet. Bitte "npm run setup" ausführen.'); process.exit(1); }
const cfg = loadConfig();
const url = `http://localhost:${cfg.server.port}/dashboard#token=${cfg.server.adminToken}`;
console.log('Öffne das Dashboard (ChaosCore muss laufen).');
if (process.env.UCC_NO_OPEN) console.log('(Browser-Start unterdrückt)');
openDashboard(url, cfg.server.dashboardMode, path.join(DATA, 'app-profile'));
