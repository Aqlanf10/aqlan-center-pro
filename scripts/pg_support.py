"""PostgreSQL CLI connection settings without credentials in process arguments."""
import os
from urllib.parse import parse_qsl, unquote, urlparse


def connection_environment(url):
    parsed = urlparse(url)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not parsed.username:
        raise ValueError('PostgreSQL URL must include an explicit host and user.')
    database = unquote(parsed.path[1:])
    if not database or '/' in database:
        raise ValueError('PostgreSQL URL must include one explicit database name.')
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
               PGUSER=unquote(parsed.username), PGDATABASE=database, PGCONNECT_TIMEOUT='10')
    if parsed.password is not None:
        env['PGPASSWORD'] = unquote(parsed.password)
    allowed = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT',
               'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
               'channel_binding': 'PGCHANNELBINDING', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key not in allowed:
            raise ValueError('Unsupported PostgreSQL URL query option.')
        env[allowed[key]] = value
    return env
