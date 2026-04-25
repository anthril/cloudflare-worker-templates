-- Delivery log. One row per enqueued message, mutated through its lifecycle
-- (queued -> sent | failed). `attempts` is bumped on every consumer invocation.

create table if not exists deliveries (
  message_id text primary key,
  recipient text not null,
  template text not null,
  subject text,
  status text not null default 'queued',
  provider_message_id text,
  attempts integer not null default 0,
  last_error text,
  idempotency_key text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create index if not exists idx_deliveries_status on deliveries(status);
create index if not exists idx_deliveries_recipient on deliveries(recipient);
create index if not exists idx_deliveries_idempotency_key on deliveries(idempotency_key);
create index if not exists idx_deliveries_created_at on deliveries(created_at);
