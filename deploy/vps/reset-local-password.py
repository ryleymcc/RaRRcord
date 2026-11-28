#!/usr/bin/env python3
"""Offline credential rotation; run with RaRRcord stopped, from the repository root."""
import getpass
import hashlib
import re
import secrets
import subprocess
import unicodedata

compose = ['docker', 'compose', '-f', 'compose.rarrcord.yml']
if subprocess.check_output(compose + ['ps', '--status', 'running', '-q', 'rarrcord'], text=True).strip():
    raise SystemExit('Stop the RaRRcord service before rotating credentials.')
username = input('Existing username [admin]: ').strip().lower() or 'admin'
if not re.fullmatch(r'[a-z0-9_]{3,24}', username):
    raise SystemExit('Invalid username.')
password = getpass.getpass('New password (12–128 characters): ')
if not 12 <= len(password.encode('utf-16-le')) // 2 <= 128 or unicodedata.normalize('NFKC', password.strip()).lower() == username:
    raise SystemExit('Invalid password; choose a different password from the username.')
if password != getpass.getpass('Confirm new password: '):
    raise SystemExit('Passwords do not match.')
salt = secrets.token_bytes(16)
digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=32768, r=8, p=3, maxmem=64*1024*1024, dklen=32).hex()
del password
# Username is strictly validated above; salt/digest are hex. No cleartext password
# is written to files, printed, or passed as a command-line argument.
sql = f"""UPDATE local_accounts SET salt='{salt.hex()}', password_hash='{digest}' WHERE username='{username}';
UPDATE users SET name=username, epoch=epoch+1 WHERE id='local:{username}' AND state<>'deleted';
DELETE FROM sessions WHERE uid='local:{username}';
DELETE FROM local_sessions WHERE username='{username}';
SELECT username AS rotated_account FROM local_accounts WHERE username='{username}' AND password_hash='{digest}';
"""
runner = '''umask 077
f=$(mktemp)
trap 'rm -f "$f"' EXIT
cat > "$f"
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to /data --file "$f"
'''
subprocess.run(compose + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'rarrcord', '-ec', runner], input=sql, text=True, check=True)
print('Check that rotated_account in the result is your username. Do not restart if it is absent.')
