import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), '..', '..');

export function loadEnvironment(): void {
  const initialEnvironment = process.env.NODE_ENV ?? 'development';
  const environmentFile = initialEnvironment === 'test' ? '.env.test' : '.env';
  dotenv.config({ path: path.join(projectRoot, environmentFile), quiet: true });
}
