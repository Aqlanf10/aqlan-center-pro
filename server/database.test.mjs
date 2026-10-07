import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {databaseOptions} from './database.mjs';

test('database TLS CA survives pg parsing with verification enabled',()=>{
 const ca='synthetic configuration fixture, not a certificate';
 const options=databaseOptions({DATABASE_URL:'postgresql://fixture@db.example.invalid/clinic',DATABASE_CA_CERT:ca});
 const parsed=new pg.Client(options).connectionParameters;
 assert.equal(parsed.ssl.ca,ca);
 assert.equal(parsed.ssl.rejectUnauthorized,true);
 assert.equal(parsed.host,'db.example.invalid');
});
test('database TLS rejects connection-string settings which would replace CA or disable verification',()=>{
 for(const key of ['sslmode','sslrootcert','sslkey','sslcert','ssl','sslnegotiation']) {
  assert.throws(()=>databaseOptions({DATABASE_URL:`postgresql://fixture@db.example.invalid/clinic?${key}=disable`,DATABASE_CA_CERT:'fixture'}),/DATABASE_TLS_OPTIONS_CONFLICT/);
 }
 assert.throws(()=>databaseOptions({DATABASE_URL:'postgresql://fixture@localhost/clinic',DATABASE_CA_CERT:''}),/DATABASE_CA_CERT_REQUIRED/);
});
test('invalid database configuration fails without echoing connection credentials',()=>{
 assert.throws(()=>databaseOptions({}),/DATABASE_URL_REQUIRED/);
 assert.throws(()=>databaseOptions({DATABASE_URL:'not a URL private-value'}),error=>error.message==='DATABASE_URL_INVALID');
 assert.throws(()=>databaseOptions({DATABASE_URL:'https://fixture:private-value@example.invalid/clinic'}),error=>error.message==='DATABASE_URL_INVALID');
 const local=new pg.Client(databaseOptions({DATABASE_URL:'postgresql://fixture@localhost/clinic?sslmode=disable'}));
 assert.equal(local.connectionParameters.ssl,false,'Disposable local tests may explicitly use their loopback non-TLS server without a CA');
});
