/** Append-only migration, shared by fresh schema generation and deployed instance chains. */
export const emailDeliverySchema = `ALTER TABLE email_outbox ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sending','sent','failed'));
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN sent_at TEXT;
ALTER TABLE email_outbox ADD COLUMN last_error TEXT;
`
