-- Add summary_date and summary_type columns for daily summaries support
ALTER TABLE summaries ADD COLUMN summary_date TEXT;
ALTER TABLE summaries ADD COLUMN summary_type TEXT DEFAULT 'weekly';

-- Backfill existing rows: summary_date = week_end
UPDATE summaries SET summary_date = week_end WHERE summary_date IS NULL;

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_summaries_date ON summaries(summary_date);
CREATE INDEX IF NOT EXISTS idx_summaries_type ON summaries(summary_type);
CREATE INDEX IF NOT EXISTS idx_summaries_chat_date ON summaries(chat_id, summary_date);
