import os
from pathlib import Path
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch

from pg_support import connection_environment, _cleanup_ca_files


CERTIFICATE = (Path(__file__).parent / 'fixtures' / 'test-ca.pem').read_text()
URL = 'postgresql://runtime:synthetic-password@db.example:5432/clinic_test'


class ConnectionEnvironmentTests(unittest.TestCase):
    def tearDown(self):
        _cleanup_ca_files()

    def test_ca_enforces_hostname_verification_and_cleans_up_file(self):
        with patch.dict(os.environ, {'DATABASE_CA_CERT': CERTIFICATE, 'PGSSLMODE': 'disable',
                                     'PGSSLROOTCERT': '/untrusted', 'PGPASSWORD': 'wrong'}, clear=True):
            env = connection_environment(URL)
            self.assertEqual(env['PGSSLMODE'], 'verify-full')
            self.assertEqual(env['PGHOST'], 'db.example')
            self.assertEqual(env['PGPASSWORD'], 'synthetic-password')
            trust = Path(env['PGSSLROOTCERT'])
            self.assertEqual(trust.read_text(), CERTIFICATE)
            if os.name == 'posix':
                self.assertEqual(stat.S_IMODE(trust.stat().st_mode), 0o600)
            self.assertEqual(connection_environment(URL)['PGSSLROOTCERT'], str(trust))
            _cleanup_ca_files()
            self.assertFalse(trust.exists())

    def test_certificate_file_is_removed_at_subprocess_exit(self):
        environment = dict(os.environ, DATABASE_CA_CERT=CERTIFICATE)
        process = subprocess.run([sys.executable, '-c',
            "from pg_support import connection_environment; print(connection_environment('postgresql://runtime@db.example/clinic_test')['PGSSLROOTCERT'])"],
            cwd=Path(__file__).parent, env=environment, capture_output=True, text=True, check=True)
        self.assertFalse(Path(process.stdout.strip()).exists())

    def test_ca_rejects_all_url_ssl_overrides(self):
        for key in ('sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'SSLMode', 'ssl'):
            with self.subTest(key=key), patch.dict(os.environ, {'DATABASE_CA_CERT': CERTIFICATE}, clear=True):
                with self.assertRaisesRegex(ValueError, '^DATABASE_TLS_OPTIONS_CONFLICT$'):
                    connection_environment(URL + '?' + key + '=disable')

    def test_invalid_and_empty_certificates_fail_without_echoing_contents(self):
        for certificate, message in (('', 'DATABASE_CA_CERT_REQUIRED'), ('  ', 'DATABASE_CA_CERT_REQUIRED'),
                                     ('private-looking-synthetic-input', 'DATABASE_CA_CERT_INVALID')):
            with self.subTest(message=message), patch.dict(os.environ, {'DATABASE_CA_CERT': certificate}, clear=True):
                with self.assertRaisesRegex(ValueError, '^' + message + '$'):
                    connection_environment(URL)

    def test_no_ca_preserves_supported_url_configuration_and_clears_inherited_pg(self):
        with patch.dict(os.environ, {'PGSSLMODE': 'disable', 'PGSSLROOTCERT': '/untrusted'}, clear=True):
            env = connection_environment(URL + '?sslmode=verify-full&sslrootcert=%2Foperator-ca.pem&connect_timeout=5')
            self.assertEqual(env['PGSSLMODE'], 'verify-full')
            self.assertEqual(env['PGSSLROOTCERT'], '/operator-ca.pem')
            self.assertEqual(env['PGCONNECT_TIMEOUT'], '5')
            plain = connection_environment(URL)
            self.assertNotIn('PGSSLMODE', plain)
            self.assertNotIn('PGSSLROOTCERT', plain)


if __name__ == '__main__':
    unittest.main()
