"""PostgreSQL CLI connection settings without credentials in process arguments."""
import atexit
import hashlib
import os
import ssl
import tempfile
from urllib.parse import parse_qsl, unquote, urlparse


_ca_files = {}


def _cleanup_ca_files():
    for path in list(_ca_files.values()):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    _ca_files.clear()


atexit.register(_cleanup_ca_files)


def _ca_file(certificate):
    if not certificate.strip():
        raise ValueError('DATABASE_CA_CERT_REQUIRED')
    fingerprint = hashlib.sha256(certificate.encode('utf-8')).hexdigest()
    if fingerprint in _ca_files:
        return _ca_files[fingerprint]
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=certificate)
    except (ssl.SSLError, ValueError):
        raise ValueError('DATABASE_CA_CERT_INVALID') from None
    # libpq requires a path, unlike the Node driver. Keep the public trust file
    # private and alive for all child clients; normal process exit removes it.
    descriptor, path = tempfile.mkstemp(prefix='aqlan-pg-ca-', suffix='.pem')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            os.chmod(path, 0o600)
            output.write(certificate)
        _ca_files[fingerprint] = path
        return path
    except BaseException:
        os.unlink(path)
        raise


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
    options = parse_qsl(parsed.query, keep_blank_values=True)
    certificate = os.environ.get('DATABASE_CA_CERT')
    if certificate is not None and any(key.lower().startswith('ssl') for key, _ in options):
        raise ValueError('DATABASE_TLS_OPTIONS_CONFLICT')
    for key, value in options:
        if key not in allowed:
            raise ValueError('Unsupported PostgreSQL URL query option.')
        env[allowed[key]] = value
    if certificate is not None:
        env.update(PGSSLMODE='verify-full', PGSSLROOTCERT=_ca_file(certificate))
    return env
