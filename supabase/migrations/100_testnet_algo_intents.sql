-- TESTNET conditional intents live beside their existing entry intent.
-- Contains order identities/payload/evidence only; never API credentials.
ALTER TABLE public.live_orders ADD COLUMN IF NOT EXISTS testnet_algo_intents jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.live_orders ADD CONSTRAINT live_orders_algo_intents_object
  CHECK (jsonb_typeof(testnet_algo_intents) = 'object');
CREATE INDEX IF NOT EXISTS live_orders_unfinished_algo_owner
  ON public.live_orders(user_id,connection_id)
  WHERE exchange='binance' AND mode='TESTNET' AND testnet_algo_intents <> '{}'::jsonb;
COMMENT ON COLUMN public.live_orders.testnet_algo_intents IS
  'Owned Binance TESTNET conditional intents. Persist SENT with a stable clientAlgoId before POST; never resend ambiguous submissions. Updates compare the previous JSONB snapshot.';
