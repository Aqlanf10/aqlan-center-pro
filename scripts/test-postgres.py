#!/usr/bin/env python3
"""Real PostgreSQL multi-connection tests. Only disposable *_test databases allowed."""
import json
import os
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
    sql(command('plan.activate', {'planId': identity}))
    return identity


def race(first_sql, second_sql):
    # First holds its transaction/plan lock while the second connection executes.
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
