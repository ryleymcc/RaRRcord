CREATE TABLE local_accounts (
    username TEXT PRIMARY KEY NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
);
CREATE TABLE local_sessions (
    token TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL REFERENCES local_accounts(username),
    expires INTEGER NOT NULL
);
CREATE INDEX local_sessions_user ON local_sessions(username, expires);
CREATE TABLE local_auth_rate (
    bucket TEXT PRIMARY KEY NOT NULL,
    minute INTEGER NOT NULL,
    hits INTEGER NOT NULL
);
