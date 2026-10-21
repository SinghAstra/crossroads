import type { Environment } from './types.ts';

export function readString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = readString(name, String(fallback));
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

export function readEnvironment(): Environment {
  const value = readString('NODE_ENV', 'development');
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error(`Unsupported NODE_ENV value: ${value}`);
  }
  return value;
}
