import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { hashPassword, verifyPassword } from './password.mjs';
import { readPatientHistory, reviewPatientHistory } from './patient-history.mjs';
import { accountSecurity } from './account-security.mjs';
import { appointmentsApi } from './appointments.mjs';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = token => createHash('sha256').update(token).digest('hex');
function fail(status, code) { throw Object.assign(new Error(code), { status }); }
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'JSON_REQUIRED');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) fail(413, 'BODY_TOO_LARGE'); chunks.push(chunk); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'INVALID_JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') fail(400, 'OBJECT_REQUIRED');
  return data;
}
export function createApp({ db, origin, production = false, webRoot = resolve('web'), now = () => Date.now() }) {
  if (!db?.query || !origin || new URL(origin).origin !== origin || (production && !origin.startsWith('https://'))) throw new Error('VALID_ORIGIN_AND_DB_REQUIRED');
  const cookieName = production ? '__Host-aqlan_session' : 'aqlan_session';
  const failures = new Map();
  const account = accountSecurity({db,now});
  const appointments = appointmentsApi({db,now});
  const dummy = hashPassword(randomBytes(32).toString('hex'));
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${production ? '; Secure' : ''}`;
  async function permission(actor, branch, code) { await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor,branch,code]); }
  async function requirePatient(actor, branch, patient) {
    await permission(actor,branch,'patient.read');
    const r = await db.query('SELECT 1 FROM clinic.patient_branch WHERE branch_id=$1 AND patient_id=$2',[branch,patient]);
    if (!r.rows.length) fail(404,'NOT_FOUND');
  }
  return createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status,value) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url,origin), path = url.pathname;
      if (req.method === 'GET' && path === '/health/live') return send(200,{live:true});
      if (req.method === 'GET' && path === '/health/ready') {
        try { const r = await db.query('SELECT max(version) AS version FROM clinic.schema_version'); const version=Number(r.rows[0]?.version); if (!Number.isInteger(version) || version<8) throw new Error(); return send(200,{ready:true}); }
        catch { return send(503,{ready:false}); }
      }
      if (!path.startsWith('/api/')) {
        if (req.method!=='GET' && req.method!=='HEAD') fail(405,'METHOD_NOT_ALLOWED');
        // Flat, explicit asset extensions. Never serve source, config, credentials or arbitrary paths.
        const name = path==='/' ? 'index.html' : path.slice(1);
        if (path==='/domain/money.mjs') { const content=await readFile(new URL('../packages/domain/money.mjs',import.meta.url)); res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}); return res.end(req.method==='HEAD'?undefined:content); }
        if (!/^[a-zA-Z0-9_-]+\.(html|css|js|mjs|svg|png|ico|webp)$/.test(name)) fail(404,'NOT_FOUND');
        let content; try { content=await readFile(resolve(webRoot,name)); } catch { fail(404,'NOT_FOUND'); }
        const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon'};
        res.writeHead(200,{'Content-Type':mime[extname(name)]}); return res.end(req.method==='HEAD'?undefined:content);
      }
      if (!['GET','POST'].includes(req.method)) fail(405,'METHOD_NOT_ALLOWED');
      if (req.method==='POST' && (req.headers.origin!==origin || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])))) fail(403,'ORIGIN_REJECTED');
      if (path==='/api/login' && req.method==='POST') {
        const input=await body(req); const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
        if (!/^[a-z0-9._@+-]{3,100}$/.test(username) || typeof input.password!=='string' || input.password.length>256) fail(400,'INVALID_LOGIN_INPUT');
        // Do not trust forwarded IP headers. Account throttle also protects behind a proxy.
        const keys=[`ip:${req.socket.remoteAddress}`,`user:${username}`];
        for (const [key,value] of failures) if (value.until<=now()) failures.delete(key);
        if (failures.size>10000) fail(429,'TRY_LATER');
        if (keys.some(key=>(failures.get(key)?.count||0)>=5)) fail(429,'TRY_LATER');
        for (const key of keys) { const state=failures.get(key)||{count:0,until:now()+15*60*1000}; state.count++; failures.set(key,state); }
        const r=await db.query('SELECT a.staff_id,a.password_hash,a.credential_version FROM clinic.login_account a JOIN clinic.staff s ON s.id=a.staff_id WHERE a.username=$1 AND s.active',[username]);
        if (!await verifyPassword(input.password,r.rows[0]?.password_hash || await dummy) || !r.rows.length) fail(401,'INVALID_CREDENTIALS');
        const token=randomBytes(32).toString('hex');
        // The SQL lock/version check prevents an old-password login racing a
        // password change from creating a valid session after revocation.
        await db.query('SELECT clinic.issue_session($1,$2,$3)',[r.rows[0].staff_id,r.rows[0].credential_version,hash(token)]);
        // Preserve source-IP budget; rotating valid users must not bypass failed-account limits.
        for (const key of keys) { const state=failures.get(key); if(state) { state.count--; if(state.count<=0) failures.delete(key); } }
        res.setHeader('Set-Cookie',cookie(token,28800)); return send(200,{ok:true});
      }
      // Public lounge and public appointment request: no staff session. The
      // lounge device holds no doctor or manager session by design (LOUNGE-02).
      if (path.startsWith('/api/public/')) {
        const loungeRoute=req.method==='GET'&&path.match(/^\/api\/public\/lounge\/([^/]+)$/);
        if (loungeRoute) return send(200,await appointments.publicLounge(decodeURIComponent(loungeRoute[1]),url.searchParams.get('since')));
        if (req.method==='POST'&&path==='/api/public/appointment-request') return send(200,await appointments.createRequest(await body(req),req.socket.remoteAddress));
        fail(404,'NOT_FOUND');
      }
      const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) fail(401,'AUTH_REQUIRED');
      const session=await db.query('SELECT s.id,s.display_name,a.username,t.id AS session_id FROM clinic.session t JOIN clinic.staff s ON s.id=t.staff_id JOIN clinic.login_account a ON a.staff_id=s.id WHERE t.token_hash=$1 AND t.expires_at>now() AND s.active AND t.credential_version=a.credential_version',[hash(token)]);
      const user=session.rows[0]; if (!user) fail(401,'AUTH_REQUIRED');
      if (path==='/api/me' && req.method==='GET') return send(200,{user:{id:user.id,display_name:user.display_name,username:user.username}});
      if (path==='/api/logout' && req.method==='POST') { await body(req); await account.revoke(user.id,hash(token),user.session_id); res.setHeader('Set-Cookie',cookie('',0)); return send(200,{ok:true}); }
      if(path==='/api/account/sessions'&&req.method==='GET') return send(200,await account.sessions(user.id,hash(token)));
      if(path==='/api/account/password'&&req.method==='POST') {
        const changed=await account.password(user.id,hash(token),await body(req));
        res.setHeader('Set-Cookie',cookie('',0)); return send(200,changed);
      }
      if(path==='/api/account/sessions/revoke-others'&&req.method==='POST') {
        await body(req); return send(200,await account.revokeOthers(user.id,hash(token)));
      }
      const revokeRoute=path.match(/^\/api\/account\/sessions\/([^/]+)\/revoke$/);
      if(revokeRoute&&req.method==='POST') {
        await body(req); const revoked=await account.revoke(user.id,hash(token),revokeRoute[1]);
        if(revoked.signedOut) res.setHeader('Set-Cookie',cookie('',0));
        return send(200,revoked);
      }
      if (path==='/api/branches' && req.method==='GET') {
        const r=await db.query('SELECT b.id,b.name,b.timezone,array_agg(DISTINCT rp.permission) AS permissions FROM clinic.branch b JOIN clinic.membership m ON m.branch_id=b.id JOIN clinic.role_permission rp ON rp.role_id=m.role_id WHERE m.staff_id=$1 AND b.active GROUP BY b.id ORDER BY b.name',[user.id]); return send(200,{branches:r.rows});
      }
      if (path==='/api/specialties' && req.method==='GET') return send(200,{specialties:(await db.query('SELECT code,name_ar FROM clinic.specialty ORDER BY code')).rows});
      const scheduleRoute=path.match(/^\/api\/branches\/([^/]+)\/(appointments|arrivals|appointment-requests|schedule-config)$/);
      if (scheduleRoute) {
        if (req.method!=='GET') fail(405,'METHOD_NOT_ALLOWED');
        const [,scheduleBranch,scheduleKind]=scheduleRoute;
        if (!UUID.test(scheduleBranch)) fail(404,'NOT_FOUND');
        await permission(user.id,scheduleBranch,'appointment.write');
        if (scheduleKind==='appointments') return send(200,await appointments.listAppointments(user.id,scheduleBranch,url.searchParams.get('date')));
        if (scheduleKind==='arrivals') return send(200,await appointments.listArrivals(user.id,scheduleBranch,url.searchParams.get('date')));
        if (scheduleKind==='appointment-requests') return send(200,await appointments.listRequests(user.id,scheduleBranch,url.searchParams.get('status')));
        return send(200,await appointments.scheduleConfig(user.id,scheduleBranch));
      }
      const historyRoute=path.match(/^\/api\/branches\/([^/]+)\/patients\/([^/]+)\/history$/);
      if(historyRoute) {
        const [,branchId,patientId]=historyRoute;
        if(!UUID.test(branchId)||!UUID.test(patientId)) fail(404,'NOT_FOUND');
        const context={db,actorId:user.id,branchId,patientId};
        if(req.method==='GET') return send(200,await readPatientHistory(context));
        const data=await body(req);
        return send(200,await reviewPatientHistory({...context,key:data.key,payload:data.payload}));
      }
      const route=path.match(/^\/api\/branches\/([^/]+)\/(commands|patients)(?:\/([^/]+)(?:\/(plans|visits|statement))?)?$/);
      if (!route || !UUID.test(route[1]) || (route[3]&&!UUID.test(route[3]))) fail(404,'NOT_FOUND');
      const [,branch,resource,patient,child]=route;
      if (resource==='commands' && !patient && req.method==='POST') {
        const data=await body(req);
        if (!UUID.test(data.key||'') || typeof data.command!=='string' || data.command.length>80 || !data.payload || Array.isArray(data.payload) || typeof data.payload!=='object') fail(400,'INVALID_COMMAND');
        for (const key of ['agreed','previouslyPaid','amount','rate']) if(data.payload[key]!=null && typeof data.payload[key]!=='string') fail(400,'DECIMAL_STRING_REQUIRED');
        const r=await db.query('SELECT clinic.execute($1,$2,$3,$4,$5::jsonb) AS result',[user.id,branch,data.key,data.command,JSON.stringify(data.payload)]); return send(200,r.rows[0].result);
      }
      if (resource!=='patients' || req.method!=='GET') fail(404,'NOT_FOUND');
      await permission(user.id,branch,'patient.read');
      if (!patient) {
        const q=(url.searchParams.get('q')||'').trim(); if(q.length>100) fail(400,'SEARCH_TOO_LONG');
        const r=await db.query("SELECT p.id,p.file_number,p.full_name,p.phone,p.birth_date::text,p.created_at FROM clinic.patient p JOIN clinic.patient_branch pb ON pb.patient_id=p.id WHERE pb.branch_id=$1 AND ($2='' OR p.full_name ILIKE '%'||$2||'%' OR p.phone ILIKE '%'||$2||'%' OR p.file_number::text=$2) ORDER BY p.created_at DESC,p.id LIMIT 100",[branch,q]); return send(200,{patients:r.rows});
      }
      await requirePatient(user.id,branch,patient);
      if (!child) { const r=await db.query('SELECT id,file_number,full_name,phone,birth_date::text,created_at FROM clinic.patient WHERE id=$1',[patient]); return send(200,{patient:r.rows[0]}); }
      if (child==='plans') {
        await permission(user.id,branch,'clinical.read');
        const r=await db.query("SELECT p.*,p.as_of_date::text AS as_of_date,coalesce((SELECT jsonb_agg(s ORDER BY s.id) FROM clinic.plan_step s WHERE s.plan_id=p.id),'[]'::jsonb) AS steps FROM clinic.plan p WHERE p.patient_id=$1 AND p.branch_id=$2 ORDER BY p.created_at DESC",[patient,branch]);
        let finance=true; try { await permission(user.id,branch,'finance.read'); } catch(e) { if(e.code!=='42501') throw e; finance=false; }
        if(!finance) for(const p of r.rows) for(const key of ['agreed','previously_paid','currency','disputed']) delete p[key];
        return send(200,{plans:r.rows});
      }
      if(child==='visits') { await permission(user.id,branch,'clinical.read'); return send(200,{visits:(await db.query('SELECT v.*,v.occurred_on::text AS occurred_on,p.title AS plan_title FROM clinic.visit v JOIN clinic.plan p ON p.id=v.plan_id WHERE v.patient_id=$1 AND v.branch_id=$2 ORDER BY v.occurred_on DESC,v.id',[patient,branch])).rows}); }
      await permission(user.id,branch,'finance.read');
      // One statement gives both views the same PostgreSQL snapshot during concurrent collection.
      // Cast every monetary value before JSON serialization; rounded cents cannot be recovered.
      const statement=await db.query(`WITH balances AS (
        SELECT l.currency,sum(l.debit-l.credit)::text AS balance
        FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id
        WHERE j.patient_id=$1 AND j.branch_id=$2 AND l.account IN ('RECEIVABLE','PATIENT_CREDIT')
        GROUP BY l.currency
      ), entries AS (
        SELECT j.*,p.amount::text AS amount,p.currency AS payment_currency,
          p.debt_amount::text AS debt_amount,p.debt_currency,p.rate::text AS rate,
          coalesce((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('debit',l.debit::text,'credit',l.credit::text) ORDER BY l.id)
            FROM clinic.journal_line l WHERE l.journal_id=j.id),'[]'::jsonb) AS lines
        FROM clinic.journal j LEFT JOIN clinic.payment p ON p.journal_id=j.id
        WHERE j.patient_id=$1 AND j.branch_id=$2
      ) SELECT coalesce((SELECT jsonb_agg(b ORDER BY b.currency) FROM balances b),'[]'::jsonb) AS balances,
          coalesce((SELECT jsonb_agg(e ORDER BY e.recorded_at,e.id) FROM entries e),'[]'::jsonb) AS entries`,[patient,branch]);
      return send(200,statement.rows[0]);
    } catch(e) {
      if(e.code==='42501'&&e.message==='AUTH_REQUIRED') { e.status=401; }
      const known=e.status || (e.code==='42501'?403:e.code==='P0002'?404:e.code?.startsWith('23')?409:['P0001','22P02','22007','22008','22003'].includes(e.code)?400:500);
      const safeCode=e.status?e.message:e.code==='42501'?'FORBIDDEN':e.code==='P0002'?'NOT_FOUND':e.code==='P0001'&&/^[A-Z_]+$/.test(e.message)?e.message:known===409?'CONFLICT':known===400?'INVALID_INPUT':'INTERNAL_ERROR';
      if(!res.headersSent) send(known,{error:safeCode}); else res.destroy();
    }
  });
}
