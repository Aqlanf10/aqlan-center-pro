import { hashPassword, verifyPassword } from './password.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=(status,code)=>{throw Object.assign(new Error(code),{status});};

// The HTTP caller supplies actor/session exclusively from authenticated cookies.
// Plaintext credentials never enter operation payloads, SQL or audit records.
export function accountSecurity({db,now=()=>Date.now()}) {
  const attempts=new Map();
  async function result(sql,parameters) {
    return (await db.query(sql,parameters)).rows[0].result;
  }
  return {
    sessions(actor,tokenHash) {
      return result('SELECT clinic.account_sessions($1,$2) AS result',[actor,tokenHash]);
    },
    revoke(actor,tokenHash,id) {
      if(!UUID.test(id)) fail(404,'NOT_FOUND');
      return result('SELECT clinic.revoke_account_session($1,$2,$3) AS result',[actor,tokenHash,id]);
    },
    revokeOthers(actor,tokenHash) {
      return result('SELECT clinic.revoke_other_sessions($1,$2) AS result',[actor,tokenHash]);
    },
    async password(actor,tokenHash,input) {
      if(Object.keys(input).some(k=>!['currentPassword','newPassword','expectedCredentialVersion'].includes(k)) ||
         typeof input.currentPassword!=='string'||input.currentPassword.length>256 ||
         typeof input.newPassword!=='string'||input.newPassword.length<12||input.newPassword.length>256 ||
         !Number.isSafeInteger(input.expectedCredentialVersion)||input.expectedCredentialVersion<1)
        fail(400,'INVALID_PASSWORD_CHANGE');
      for(const [key,value] of attempts) if(value.until<=now()) attempts.delete(key);
      if(attempts.size>=10000&&!attempts.has(actor)) fail(429,'TRY_LATER');
      const budget=attempts.get(actor)||{count:0,until:now()+15*60*1000};
      if(budget.count>=5) fail(429,'TRY_LATER');
      budget.count++; attempts.set(actor,budget);
      const account=(await db.query('SELECT password_hash,credential_version FROM clinic.login_account WHERE staff_id=$1',[actor])).rows[0];
      if(!account) fail(401,'AUTH_REQUIRED');
      if(account.credential_version!==input.expectedCredentialVersion) fail(409,'STALE_CREDENTIAL_VERSION');
      if(!await verifyPassword(input.currentPassword,account.password_hash)) fail(400,'CURRENT_PASSWORD_INCORRECT');
      if(input.currentPassword===input.newPassword) fail(400,'PASSWORD_UNCHANGED');
      const newHash=await hashPassword(input.newPassword);
      const saved=await result('SELECT clinic.change_account_password($1,$2,$3,$4,$5) AS result',
        [actor,tokenHash,input.expectedCredentialVersion,account.password_hash,newHash]);
      attempts.delete(actor);
      return saved;
    }
  };
}
