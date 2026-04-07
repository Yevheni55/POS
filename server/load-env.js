/**
 * Load server/.env regardless of process cwd (e.g. `node server/server.js` from repo root).
 * Must be the first side-effect import in app.js before routes/db load.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
