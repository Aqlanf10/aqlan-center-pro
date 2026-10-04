/** Production connection: external pg driver must be installed. No in-memory fallback. */
export function databaseOptions(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  let address;
  try { address=new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL_INVALID'); }
  if(!['postgres:','postgresql:'].includes(address.protocol)) throw new Error('DATABASE_URL_INVALID');
  const options={connectionString:env.DATABASE_URL,max:10,connectionTimeoutMillis:10000,idleTimeoutMillis:30000};
  if(env.DATABASE_CA_CERT!==undefined) {
    if(typeof env.DATABASE_CA_CERT!=='string'||!env.DATABASE_CA_CERT.trim()) throw new Error('DATABASE_CA_CERT_REQUIRED');
    // pg connection-string SSL options replace the supplied SSL object, losing its CA.
    if([...address.searchParams.keys()].some(key=>/^ssl/i.test(key))) throw new Error('DATABASE_TLS_OPTIONS_CONFLICT');
    options.ssl={ca:env.DATABASE_CA_CERT,rejectUnauthorized:true};
  }
  return options;
}
export async function connectDatabase(env = process.env) {
  const options=databaseOptions(env);
  const { Pool } = await import('pg');
  const pool = new Pool(options);
  try { await pool.query('SELECT 1'); }
  catch(error) { await pool.end(); throw error; }
  return pool;
}
