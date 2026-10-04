#!/usr/bin/env python3
"""Read-only backup of a disposable *_test database; not a production scheduler."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from pg_support import connection_environment


def query(env, statement, snapshot=None):
    if snapshot:
        if not re.fullmatch(r'[0-9A-Fa-f-]+', snapshot):
            raise ValueError('Invalid snapshot identifier.')
        statement = f"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '{snapshot}';\n{statement}\nCOMMIT;"
    result = subprocess.run(['psql', '-X', '--no-password', '-qAt', '--set=ON_ERROR_STOP=1'],
                            input=statement, text=True, capture_output=True, env=env, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def manifest(env, snapshot=None):
    tables = ['patient', 'plan', 'journal', 'journal_line', 'payment', 'audit']
    counts = {name: int(query(env, f'SELECT count(*) FROM clinic.{name};', snapshot)) for name in tables}
    versions = json.loads(query(env, "SELECT json_agg(version ORDER BY version) FROM clinic.schema_version;", snapshot))
    history_present = query(env, "SELECT to_regclass('clinic.patient_history_revision') IS NOT NULL;", snapshot) == 't'
    if max(versions or [0]) >= 6 and not history_present:
        raise RuntimeError('Reviewed-history schema version is present but its revision table is missing.')
    history = {'present': history_present}
    if history_present:
        counts['patient_history_revision'] = int(query(env, 'SELECT count(*) FROM clinic.patient_history_revision;', snapshot))
        # Stable JSONB key order, explicit chronological ordering and UTC timestamps
        # fingerprint every immutable field, not just row counts. Never print rows.
        # Each row is JSON-escaped onto one line, so embedded clinical newlines cannot
        # create ambiguous record boundaries. Raw history stays out of the manifest.
        content = query(env, """SELECT (to_jsonb(r) || jsonb_build_object(
            'observed_on',to_char(r.observed_on,'YYYY-MM-DD'),
            'reviewed_at',to_char(r.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text
          FROM clinic.patient_history_revision r
          ORDER BY r.patient_id,r.branch_id,r.version,r.id;""", snapshot)
        history['sha256'] = hashlib.sha256(content.encode('utf-8')).hexdigest()
    balances = json.loads(query(env, """SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.branch_id,t.account,t.currency),'[]')
      FROM (SELECT j.branch_id,l.account,l.currency,sum(l.debit)::text AS debit,sum(l.credit)::text AS credit,
       sum(l.debit-l.credit)::text AS balance FROM clinic.journal_line l JOIN clinic.journal j ON j.id=l.journal_id
       GROUP BY j.branch_id,l.account,l.currency) t;""", snapshot))
    sequences = {}
    names = json.loads(query(env, "SELECT coalesce(json_agg(sequencename ORDER BY sequencename),'[]') FROM pg_sequences WHERE schemaname='clinic';", snapshot))
    for name in names:
        quoted = 'clinic."' + name.replace('"', '""') + '"'
        state = json.loads(query(env, f'SELECT row_to_json(s) FROM (SELECT last_value::text,is_called FROM {quoted}) s;', snapshot))
        # Catalog metadata is read only; never advance the source sequence.
        settings = json.loads(query(env, "SELECT row_to_json(s) FROM (SELECT increment_by::text,min_value::text,max_value::text,cycle FROM pg_sequences WHERE schemaname='clinic' AND sequencename='" + name.replace("'", "''") + "') s;", snapshot))
        sequences[name] = dict(state, **settings)
    return {'counts': counts, 'schemaVersions': versions, 'balances': balances,
            'sequences': sequences, 'patientHistory': history}


def backup(url, destination):
    env = connection_environment(url)
    if not env['PGDATABASE'].endswith('_test'):
        raise ValueError('Backup rehearsal only accepts a disposable *_test source.')
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(destination, 0o700)
    dump = destination / 'database.dump'
    export = subprocess.Popen(['psql', '-X', '--no-password', '-qAt', '--set=ON_ERROR_STOP=1'],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        export.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
        export.stdin.flush()
        snapshot = export.stdout.readline().strip()
        if not re.fullmatch(r'[0-9A-Fa-f-]+', snapshot):
            raise RuntimeError('Unable to export a consistent database snapshot.')
        expected = manifest(env, snapshot)
        fd = os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            result = subprocess.run(['pg_dump', '--no-password', '--format=custom', '--snapshot=' + snapshot],
                                    stdout=output, stderr=subprocess.PIPE, env=env, timeout=120)
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        document = {'formatVersion': 1, 'sourceDatabase': env['PGDATABASE'], 'sha256': digest, 'expected': expected}
        fd = os.open(destination / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(document, output, indent=2)
        return document
    finally:
        if export.poll() is None:
            export.stdin.write('ROLLBACK;\n\\q\n')
            export.stdin.flush()
            export.stdin.close()
            try:
                export.wait(timeout=10)
            except subprocess.TimeoutExpired:
                export.kill()
                export.wait()


if __name__ == '__main__':
    if len(sys.argv) != 2 or not os.environ.get('TEST_DATABASE_URL'):
        sys.exit('Usage: TEST_DATABASE_URL=<disposable database> python3 scripts/backup.py NEW_OUTPUT_DIRECTORY')
    backup(os.environ['TEST_DATABASE_URL'], sys.argv[1])
    print('Backup and checksum manifest written. Files contain sensitive data; keep private.')
