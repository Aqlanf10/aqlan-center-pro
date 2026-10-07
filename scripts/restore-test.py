#!/usr/bin/env python3
"""Restore rehearsal into a new, explicitly named disposable database only."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
from backup import backup, manifest, query
from pg_support import connection_environment

source_url = os.environ.get('TEST_DATABASE_URL', '')
target_url = os.environ.get('RESTORE_TEST_DATABASE_URL', '')
source = connection_environment(source_url)
target = connection_environment(target_url)
if not source['PGDATABASE'].endswith('_test') or not target['PGDATABASE'].endswith('_restore_test'):
    raise ValueError('Source must end in _test and target must end in _restore_test.')
if source['PGDATABASE'] == target['PGDATABASE']:
    raise ValueError('Source and target database names must differ.')
if any(source[key] != target[key] for key in ('PGHOST', 'PGPORT', 'PGUSER')):
    raise ValueError('This rehearsal requires the same disposable cluster and owner role.')

with tempfile.TemporaryDirectory(prefix='aqlan-restore-') as temporary:
    folder = Path(temporary) / 'backup'
    document = backup(source_url, folder)
    dump = folder / 'database.dump'
    if hashlib.sha256(dump.read_bytes()).hexdigest() != document['sha256']:
        raise AssertionError('Backup checksum mismatch.')
    maintenance = dict(target, PGDATABASE='postgres')
    quoted_name = '"' + target['PGDATABASE'].replace('"', '""') + '"'
    # CREATE fails if the target exists. Never drop, empty or overwrite an existing DB.
    query(maintenance, 'CREATE DATABASE ' + quoted_name + ' TEMPLATE template0;')
    result = subprocess.run(['pg_restore', '--no-password', '--exit-on-error', '--single-transaction',
                             '--dbname=' + target['PGDATABASE'], str(dump)],
                            env=target, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr)
    restored = manifest(target)
    if restored != document['expected']:
        raise AssertionError('Restored counts, schema versions, currency balances or sequence states differ.')
    for name, state in restored['sequences'].items():
        last = int(state['last_value'])
        expected = last + int(state['increment_by']) if state['is_called'] else last
        if expected > int(state['max_value']) or expected < int(state['min_value']):
            if not state['cycle']:
                raise AssertionError('Restored sequence exhausted.')
            expected = int(state['min_value'] if int(state['increment_by']) > 0 else state['max_value'])
        identifier = 'clinic."' + name.replace('"', '""') + '"'
        escaped = identifier.replace("'", "''")
        # Only the fresh restore target advances. Source sequence values never change.
        actual = int(query(target, "SELECT nextval('" + escaped + "'::regclass);"))
        if actual != expected:
            raise AssertionError('Restored next sequence value differs.')
    if manifest(source) != document['expected']:
        raise AssertionError('Source changed during the restore rehearsal; source must be quiescent.')
    print('PASS: backup checksum, restore, row counts, schema versions, per-currency ledger and next sequence IDs')
    print('Disposable restore database retained for inspection; temporary sensitive dump removed.')
