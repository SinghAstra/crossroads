import { createPool } from 'mysql2/promise';
import config from '../config/index.ts';

const pool = createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  maxIdle: config.db.connectionLimit,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: 'Z',
  decimalNumbers: true,
});

export default pool;
