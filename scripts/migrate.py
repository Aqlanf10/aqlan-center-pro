#!/usr/bin/env python3
"""Atomic, serialized PostgreSQL migrations. Run with the migration owner only."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
from pg_support import connection_environment

ROOT = Path(__file__).resolve().parents[1]


def main():
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('DATABASE_URL is required; no fallback database is allowed.')
    files = sorted((ROOT / 'db').glob('*.sql'))
    versions = []
    chunks = ["SELECT pg_advisory_xact_lock(147830091, 1);",
              "CREATE TABLE IF NOT EXISTS public.aqlan_schema_migration (version integer PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());"]
    for file in files:
        match = re.fullmatch(r'(\d{3})_[a-z0-9_]+\.sql', file.name)
        if not match:
            sys.exit(f'Invalid migration name: {file.name}')
        version = int(match[1])
        versions.append(version)
        content = file.read_text()
        checksum = hashlib.sha256(file.read_bytes()).hexdigest()
        chunks += [f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.aqlan_schema_migration WHERE version={version} AND sha256<>'{checksum}') THEN RAISE EXCEPTION 'MIGRATION_CHECKSUM_MISMATCH_{version}'; END IF; END $$;",
                   f"SELECT EXISTS(SELECT 1 FROM public.aqlan_schema_migration WHERE version={version}) AS applied \\gset",
                   "\\if :applied", f"\\echo Migration {version} already applied", "\\else", content,
                   f"INSERT INTO public.aqlan_schema_migration(version,sha256) VALUES({version},'{checksum}');", "\\endif"]
    if versions != list(range(1, len(files) + 1)):
        sys.exit('Migrations must have contiguous unique versions starting at 001.')
    if not files:
        sys.exit('No migrations found.')
    chunks.append(f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.aqlan_schema_migration WHERE version>{len(files)}) THEN RAISE EXCEPTION 'DATABASE_NEWER_THAN_THIS_RELEASE'; END IF; END $$;")
    # Keep connection credentials out of process arguments and normal logs.
    environment = connection_environment(url)
    result = subprocess.run(['psql', '-X', '--no-password', '--set=ON_ERROR_STOP=1', '--single-transaction', '--file=-'],
                            input='\n'.join(chunks), text=True, env=environment)
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
