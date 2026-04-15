/**
 * Load server/.env regardless of process cwd (e.g. `node server/server.js` from repo root).
 * Must be the first side-effect import in app.js before routes/db load.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// Fail fast if JWT_SECRET is missing or trivially weak
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is not set or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}
