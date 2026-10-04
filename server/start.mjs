import { createApp } from './app.mjs';
import { connectDatabase } from './database.mjs';
const production=process.env.NODE_ENV==='production';
if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN_REQUIRED');
const db=await connectDatabase();
const role=await db.query("SELECT r.rolsuper, r.rolname, n.nspowner=r.oid AS owns_schema FROM pg_roles r JOIN pg_namespace n ON n.nspname='clinic' WHERE r.rolname=current_user");
if (production && (!role.rows.length || role.rows[0].rolsuper || role.rows[0].owns_schema)) throw new Error('PRODUCTION_REQUIRES_NON_OWNER_DB_ROLE');
if (production) {
  const unsafe=await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='clinic' AND c.relkind IN ('r','p') AND
      (pg_has_role(current_user,c.relowner,'MEMBER') OR
       (c.relname<>'session' AND (has_table_privilege(current_user,c.oid,'INSERT') OR
        has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE') OR
        has_table_privilege(current_user,c.oid,'TRUNCATE')))) LIMIT 1`);
  if(unsafe.rows.length) throw new Error('PRODUCTION_REQUIRES_COMMAND_ONLY_WRITES');
}
const server=createApp({db,origin:process.env.APP_ORIGIN,production});
const port=Number(process.env.PORT||3000);
if (!Number.isInteger(port)||port<1||port>65535) throw new Error('INVALID_PORT');
server.requestTimeout=15000; server.headersTimeout=10000; server.maxHeadersCount=50;
server.listen(port,'0.0.0.0',()=>console.log(`Aqlan Center Pro listening on port ${port}`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ server.close(async()=>{ await db.end(); process.exit(0); }); setTimeout(()=>process.exit(1),10000).unref(); });
