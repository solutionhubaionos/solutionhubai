-- Conversation scope: the industries and companies a user picked for one chat.
--
-- Stored with the conversation so the server can load it on every turn instead
-- of trusting the client to resend it, and so it survives a reload, a new
-- message and a later session of the same conversation. An industry with no
-- companies picked means the whole industry is in scope.
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{"industries":[],"companies":[],"updatedAt":null}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON public.conversations (user_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- Owner-only in every direction: a conversation's scope names the companies a
-- user cares about, so it is never visible to anyone else.
DROP POLICY IF EXISTS "Owners read their conversations" ON public.conversations;
CREATE POLICY "Owners read their conversations" ON public.conversations FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners create their conversations" ON public.conversations;
CREATE POLICY "Owners create their conversations" ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners update their conversations" ON public.conversations;
CREATE POLICY "Owners update their conversations" ON public.conversations FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners delete their conversations" ON public.conversations;
CREATE POLICY "Owners delete their conversations" ON public.conversations FOR DELETE TO authenticated
  USING (user_id = auth.uid());
