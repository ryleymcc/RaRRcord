-- Purge previously accepted local display names and invalidate old sessions.
UPDATE users SET name=username, epoch=epoch+1 WHERE id='local:'||username AND state<>'deleted';
DELETE FROM sessions WHERE uid IN (SELECT id FROM users WHERE id='local:'||username);
DELETE FROM local_sessions;
