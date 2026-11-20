-- Persistent chats: the transcript and the guided-intake state of a
-- conversation, so a reload or a later session reopens the same chat and the
-- sidebar can list every past one. Owner-only RLS from 0022 still governs it.
--
-- The transcript is stored whole (including a generated document's bytes) so a
-- reopened chat keeps its download; the list query never reads this column.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS intake jsonb;
