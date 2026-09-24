CREATE TABLE IF NOT EXISTS ai_daily_usage (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (day, subject)
);
