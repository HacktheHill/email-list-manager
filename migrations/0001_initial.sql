CREATE TABLE IF NOT EXISTS subscribers (
	 email_normalized TEXT PRIMARY KEY,
	 email_original TEXT NOT NULL,
	 status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed')),
	 source TEXT NOT NULL,
	 consent_text_version TEXT NOT NULL,
	 requested_at TEXT,
	 confirmed_at TEXT,
	 unsubscribed_at TEXT,
	 confirmation_sent_at TEXT,
	 updated_at TEXT NOT NULL,
	 confirmation_token_hash TEXT,
	 confirmation_expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS subscribers_confirmation_token
ON subscribers (confirmation_token_hash)
WHERE confirmation_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscribers_status_email
ON subscribers (status, email_normalized);

CREATE TABLE IF NOT EXISTS subscription_events (
	 id INTEGER PRIMARY KEY AUTOINCREMENT,
	 email_normalized TEXT,
	 event_type TEXT NOT NULL,
	 source TEXT NOT NULL,
	 occurred_at TEXT NOT NULL,
	 consent_text_version TEXT,
	 metadata_json TEXT,
	 FOREIGN KEY (email_normalized) REFERENCES subscribers(email_normalized)
);

CREATE INDEX IF NOT EXISTS subscription_events_email_time
ON subscription_events (email_normalized, occurred_at);
