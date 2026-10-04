/** Production connection: external pg driver must be installed. No in-memory fallback. */
export async function connectDatabase(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString:env.DATABASE_URL, max:10, connectionTimeoutMillis:10000, idleTimeoutMillis:30000 });
  await pool.query('SELECT 1');
  return pool;
}
