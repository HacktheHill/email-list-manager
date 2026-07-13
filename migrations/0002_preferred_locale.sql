ALTER TABLE subscribers
ADD COLUMN preferred_locale TEXT NOT NULL DEFAULT 'en'
CHECK (preferred_locale IN ('en', 'fr'));
