from pathlib import Path
import secrets, os
p = Path('.dev.vars.vps')
# Never overwrite an existing registration code file.
fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('RARRCORD_OWNER_CODE=' + secrets.token_urlsafe(32) + '\n')
    f.write('RARRCORD_REGISTRATION_CODE=' + secrets.token_urlsafe(32) + '\n')
print('Created .dev.vars.vps with mode 0600. View it privately; do not paste the codes into chat.')
