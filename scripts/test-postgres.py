#!/usr/bin/env python3
"""Real PostgreSQL multi-connection tests. Only disposable *_test databases allowed."""
import json
import os
import secrets
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse
from uuid import uuid4
from pg_support import connection_environment

url = os.environ.get('TEST_DATABASE_URL', '')
parsed = urlparse(url)
if parsed.scheme not in ('postgres', 'postgresql') or not unquote(parsed.path[1:]).endswith('_test'):
    sys.exit('TEST_DATABASE_URL must name a disposable database ending in _test.')
env = connection_environment(url)
env['PGOPTIONS'] = '-c statement_timeout=12000 -c lock_timeout=10000'
args = ['psql', '-X', '--no-password', '-qAt', '--set=ON_ERROR_STOP=1']


def sql(statement):
    result = subprocess.run(args, input=statement, text=True, capture_output=True, env=env, timeout=20)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


branch, actor, role = [str(uuid4()) for _ in range(3)]
sql(f"INSERT INTO clinic.branch(id,name) VALUES('{branch}','Concurrency fixture'); INSERT INTO clinic.staff(id,display_name) VALUES('{actor}','Test actor'); INSERT INTO clinic.role(id,name) VALUES('{role}','{role}'); INSERT INTO clinic.role_permission SELECT '{role}',code FROM clinic.permission; INSERT INTO clinic.membership VALUES('{actor}','{branch}','{role}');")


def command(name, payload, key=None):
    return f"SELECT clinic.execute('{actor}','{branch}','{key or uuid4()}',{literal(name)},{literal(json.dumps(payload))}::jsonb);"


patient = json.loads(sql(command('patient.create', {'fullName': 'Concurrent Test'})))['id']


def plan():
    identity = json.loads(sql(command('plan.create', {'patientId': patient, 'specialty': 'orthodontics', 'title': 'Concurrent plan', 'origin': 'new', 'currency': 'SAR', 'agreed': '100.00'})))['id']
    sql(command('plan.activate', {'planId': identity, 'expectedVersion': 1}))
    return identity


def race(first_sql, second_sql):
    # First holds its transaction/row lock while the second connection executes.
    first = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    first.stdin.write('BEGIN;\n' + first_sql + '\n\\echo LOCK_HELD\nSELECT pg_sleep(2);\nCOMMIT;\n')
    first.stdin.close()
    try:
        while True:
            line = first.stdout.readline()
            if line.strip() == 'LOCK_HELD':
                break
            if not line:
                raise AssertionError(first.stderr.read())
        second = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        second.stdin.write(second_sql)
        second.stdin.close()
        time.sleep(0.2)
        assert second.poll() is None, 'Second transaction should wait on the first lock'
        first.wait(timeout=15)
        second.wait(timeout=15)
        assert first.returncode == 0, first.stderr.read()
        return second.returncode, second.stdout.read(), second.stderr.read()
    finally:
        for proc in (first, locals().get('second')):
            if proc and proc.poll() is None:
                proc.kill()
                proc.wait()


identity = plan()
payment = {'planId': identity, 'amount': '80.00', 'currency': 'SAR', 'rate': '1'}
code, _, error = race(command('payment.collect', payment), command('payment.collect', payment))
assert code != 0 and 'PAYMENT_EXCEEDS_BALANCE' in error, error
assert sql(f"SELECT sum(l.debit-l.credit) FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id WHERE j.plan_id='{identity}' AND l.account='RECEIVABLE';") == '20.00'
print('PASS: concurrent distinct payments cannot over-collect')

identity = plan()
payment['planId'] = identity
key = str(uuid4())
code, output, error = race(command('payment.collect', payment, key), command('payment.collect', payment, key))
assert code == 0, error
assert json.loads(output)['command'] == 'payment.collect'
assert sql(f"SELECT count(*) FROM clinic.journal WHERE plan_id='{identity}' AND kind='payment';") == '1'
assert sql(f"SELECT count(*) FROM clinic.audit WHERE branch_id='{branch}' AND action='payment.collect' AND entity_id={literal(json.loads(output)['id'])};") == '1'
print('PASS: concurrent retries post one payment and one audit event')

# A reviewer changes a draft while an approver holds an older screen version.
# The second transaction must acquire the row lock before checking the version.
legacy = json.loads(sql(command('plan.create', {
    'patientId': patient, 'specialty': 'orthodontics', 'title': 'Review race',
    'origin': 'legacy', 'currency': 'SAR', 'agreed': '100.00',
    'previouslyPaid': '20.00', 'sourceSystem': 'synthetic-concurrency',
    'sourceRecordId': str(uuid4()), 'asOfDate': '2026-01-01'
})))['id']
review = {'planId': legacy, 'agreed': '120.00', 'previouslyPaid': '20.00',
          'disputed': False, 'reason': 'Verified synthetic source', 'expectedVersion': 1}
activation_key = str(uuid4())
code, _, error = race(command('legacy.review', review),
                      command('legacy.activate', {'planId': legacy, 'expectedVersion': 1}, activation_key))
assert code != 0 and 'STALE_PLAN_VERSION' in error, error
assert sql(f"SELECT status || ':' || version::text FROM clinic.plan WHERE id='{legacy}';") == 'draft:2'
assert sql(f"SELECT count(*) FROM clinic.journal WHERE plan_id='{legacy}';") == '0'
assert sql(f"SELECT count(*) FROM clinic.operation WHERE branch_id='{branch}' AND key='{activation_key}';") == '0'
assert sql(f"SELECT count(*) FROM clinic.audit WHERE branch_id='{branch}' AND action='legacy.activate' AND entity_id='{legacy}';") == '0'
# A refreshed approval uses the reviewed version and posts only the new remainder.
activation = command('legacy.activate', {'planId': legacy, 'expectedVersion': 2}, activation_key)
first_result = sql(activation)
assert sql(activation) == first_result
assert sql(f"SELECT status || ':' || version::text FROM clinic.plan WHERE id='{legacy}';") == 'active:3'
assert sql(f"SELECT count(*) FROM clinic.journal WHERE plan_id='{legacy}';") == '1'
assert sql(f"SELECT sum(l.debit-l.credit) FROM clinic.journal j JOIN clinic.journal_line l ON l.journal_id=j.id WHERE j.plan_id='{legacy}' AND l.account='RECEIVABLE';") == '100.00'
print('PASS: concurrent draft review rejects stale activation; refreshed approval and retry post once')

# PAT-03 reviewed history starts without a head row, so the first-version race is
# important: two distinct keys at expectedVersion=0 must not both become version 1.
def history_command(patient_id, payload, key=None):
    return (f"SELECT clinic.review_patient_history('{actor}','{branch}',{literal(patient_id)},"
            f"'{key or uuid4()}',{literal(json.dumps(payload))}::jsonb);")


history_review = {
    'expectedVersion': 0,
    'medical': {'status': 'unknown', 'details': ''},
    'dental': {'status': 'none', 'details': ''},
    'allergies': {'status': 'reported', 'details': 'Synthetic allergy for restore test only'},
    'source': 'patient_report', 'reason': 'Synthetic first review', 'observedOn': '2024-01-02'
}
losing_key = str(uuid4())
code, _, error = race(history_command(patient, history_review),
                      history_command(patient, history_review, losing_key))
assert code != 0 and 'STALE_HISTORY_VERSION' in error, error
assert sql(f"SELECT count(*) FROM clinic.patient_history_revision WHERE patient_id='{patient}' AND branch_id='{branch}';") == '1'
assert sql(f"SELECT count(*) FROM clinic.operation WHERE branch_id='{branch}' AND key='{losing_key}';") == '0'
assert sql(f"SELECT count(*) FROM clinic.audit WHERE branch_id='{branch}' AND action='patient.history.review' AND metadata->>'patientId'='{patient}';") == '1'
print('PASS: concurrent initial history reviews retain one revision; stale operation and audit roll back')

# A new patient's concurrent retries exercise operation locking separately from
# the optimistic-version lock. Content is synthetic and never printed to logs.
retry_patient = json.loads(sql(command('patient.create', {'fullName': 'Synthetic history retry'})))['id']
history_key = str(uuid4())
code, output, error = race(history_command(retry_patient, history_review, history_key),
                          history_command(retry_patient, history_review, history_key))
assert code == 0, error
saved_history = json.loads(output)
assert saved_history['command'] == 'patient.history.review' and saved_history['version'] == 1
assert json.loads(sql(history_command(retry_patient, history_review, history_key))) == saved_history
assert sql(f"SELECT count(*) FROM clinic.patient_history_revision WHERE patient_id='{retry_patient}' AND branch_id='{branch}';") == '1'
assert sql(f"SELECT count(*) FROM clinic.audit WHERE entity_id='{saved_history['id']}' AND action='patient.history.review';") == '1'
print('PASS: concurrent history retries return one immutable revision and one audit event')

# Leave two dated revisions with different statuses for the content-fingerprint
# restore drill. A copied current state must not erase the earlier unknown value.
corrected_history = dict(history_review, expectedVersion=1, reason='Synthetic follow-up review',
                         observedOn='2024-02-03', medical={'status': 'none', 'details': ''})
sql(history_command(patient, corrected_history))
assert sql(f"SELECT string_agg(medical->>'status',',' ORDER BY version) FROM clinic.patient_history_revision WHERE patient_id='{patient}' AND branch_id='{branch}';") == 'unknown,none'
print('PASS: dated history correction preserves the original unknown state and reported allergy')

# SEC-01 self-service races use separate real connections and the restricted role.
# Format-valid synthetic digests are never printed; HTTP scrypt verification is
# covered separately. These test the verified-hash/version CAS database boundary.
def security_fixture():
    staff = str(uuid4())
    stored = 'scrypt-v1$' + secrets.token_hex(16) + '$' + secrets.token_hex(64)
    replacement = 'scrypt-v1$' + secrets.token_hex(16) + '$' + secrets.token_hex(64)
    current = secrets.token_hex(32)
    sql(f"INSERT INTO clinic.staff(id,display_name) VALUES('{staff}','Synthetic security race');"
        f"INSERT INTO clinic.login_account(staff_id,username,password_hash) VALUES('{staff}','{staff}',{literal(stored)});")
    sql(f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{current}');")
    change = (f"SET ROLE clinic_runtime; SELECT clinic.change_account_password('{staff}','{current}',1,"
              f"{literal(stored)},{literal(replacement)});")
    return staff, current, change


def security_state(staff):
    # Return only counters/epoch; do not fetch password or token material.
    return json.loads(sql(f"""SELECT json_build_object(
      'version',(SELECT credential_version FROM clinic.login_account WHERE staff_id='{staff}'),
      'sessions',(SELECT count(*) FROM clinic.session WHERE staff_id='{staff}'),
      'changes',(SELECT count(*) FROM clinic.auth_audit WHERE actor_id='{staff}' AND action='password.changed'));
      """))


staff, current, change = security_fixture()
late_login = f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{secrets.token_hex(32)}');"
code, _, error = race(change, late_login)
assert code != 0 and 'STALE_CREDENTIAL_VERSION' in error, 'Pre-change verified login must reject its stale credential epoch'
assert security_state(staff) == {'version': 2, 'sessions': 0, 'changes': 1}
print('PASS: password change locks out a concurrently issued session verified with the previous credential version')

staff, current, change = security_fixture()
early_login = f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{secrets.token_hex(32)}');"
code, output, _ = race(early_login, change)
assert code == 0, 'Password change must wait for earlier session issuance without deadlock'
assert json.loads(output) == {'credentialVersion': 2, 'signedOut': True}
assert security_state(staff) == {'version': 2, 'sessions': 0, 'changes': 1}
assert sql(f"SELECT affected_sessions FROM clinic.auth_audit WHERE actor_id='{staff}' AND action='password.changed';") == '2'
print('PASS: password change revokes sessions issued immediately before it acquires the account lock')

staff, current, change = security_fixture()
code, _, error = race(change, change)
assert code != 0 and 'AUTH_REQUIRED' in error, 'Second password change must reject its revoked current session'
assert security_state(staff) == {'version': 2, 'sessions': 0, 'changes': 1}
print('PASS: simultaneous password changes advance once and record exactly one immutable audit event')

staff, current, _ = security_fixture()
sql(f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{secrets.token_hex(32)}');")
revoke = f"SET ROLE clinic_runtime; SELECT clinic.revoke_other_sessions('{staff}','{current}');"
late_issue = f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{secrets.token_hex(32)}');"
code, output, _ = race(revoke, late_issue)
assert code == 0, 'Issuance after revoke-others must serialize successfully'
assert json.loads(output)['credentialVersion'] == 1
assert security_state(staff) == {'version': 1, 'sessions': 2, 'changes': 0}
assert sql(f"SELECT affected_sessions FROM clinic.auth_audit WHERE actor_id='{staff}' AND action='sessions.others_revoked';") == '1'
print('PASS: revoke-others preserves current epoch; a later legitimate login can create a new session')

staff, current, _ = security_fixture()
early_issue = f"SET ROLE clinic_runtime; SELECT clinic.issue_session('{staff}',1,'{secrets.token_hex(32)}');"
revoke = f"SET ROLE clinic_runtime; SELECT clinic.revoke_other_sessions('{staff}','{current}');"
code, output, _ = race(early_issue, revoke)
assert code == 0, 'Revoke-others must wait for earlier issuance without deadlock'
assert json.loads(output) == {'revokedCount': 1}
assert security_state(staff) == {'version': 1, 'sessions': 1, 'changes': 0}
assert sql(f"SELECT count(*) FROM clinic.session WHERE staff_id='{staff}' AND token_hash='{current}';") == '1'
print('PASS: revoke-others removes a concurrent earlier login while retaining the current session')
