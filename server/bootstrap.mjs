// Operator-only CLI; run against the migration/admin connection BEFORE serving.
// Pipe the password through stdin (no CLI argument, terminal echo or logs).
import { connectDatabase } from './database.mjs';
import { hashPassword } from './password.mjs';
export async function bootstrapAdmin(db,{username,password,displayName,branchName}) {
  if (!/^[a-z0-9._@+-]{3,100}$/.test(username||'') || !displayName?.trim() || !branchName?.trim() || displayName.length>160 || branchName.length>160) throw new Error('INVALID_BOOTSTRAP_INPUT');
  const passwordHash=await hashPassword(password);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE clinic.login_account IN EXCLUSIVE MODE');
    if ((await client.query('SELECT 1 FROM clinic.login_account LIMIT 1')).rows.length) throw new Error('ALREADY_BOOTSTRAPPED');
    const staff=(await client.query('INSERT INTO clinic.staff(display_name) VALUES($1) RETURNING id',[displayName.trim()])).rows[0].id;
    const branch=(await client.query('INSERT INTO clinic.branch(name) VALUES($1) RETURNING id',[branchName.trim()])).rows[0].id;
    const role=(await client.query("INSERT INTO clinic.role(name) VALUES('Owner') RETURNING id")).rows[0].id;
    await client.query('INSERT INTO clinic.role_permission SELECT $1,code FROM clinic.permission',[role]);
    await client.query('INSERT INTO clinic.membership VALUES($1,$2,$3)',[staff,branch,role]);
    await client.query('INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES($1,$2,$3)',[staff,username,passwordHash]);
    await client.query('COMMIT'); return {staffId:staff,branchId:branch};
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
if (process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  if(process.stdin.isTTY) throw new Error('PASSWORD_STDIN_REQUIRED');
  let input=''; for await(const chunk of process.stdin) { input+=chunk; if(input.length>1024) throw new Error('PASSWORD_TOO_LONG'); }
  const db=await connectDatabase();
  try { await bootstrapAdmin(db,{username:process.env.ADMIN_USERNAME,password:input.replace(/\r?\n$/,''),displayName:process.env.ADMIN_DISPLAY_NAME,branchName:process.env.BRANCH_NAME}); console.log('Initial administrator created.'); }
  finally { await db.end(); }
}
