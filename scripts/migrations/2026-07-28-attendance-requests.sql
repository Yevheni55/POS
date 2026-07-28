-- Žiadosti o opravu dochádzky (attendance_requests).
--
-- Spustiť NA KASE PRED nasadením kódu, ktorý tabuľku používa:
--   ssh surfs@100.95.64.38 "docker cp scripts/migrations/2026-07-28-attendance-requests.sql pos-db-1:/tmp/ && docker exec pos-db-1 psql -U pos -d pos -f /tmp/2026-07-28-attendance-requests.sql"
--
-- Skript je idempotentný (IF NOT EXISTS), takže opakované spustenie nič nepokazí.
--
-- Kontext: terminál pozná len „teraz". Kto príde o 8:00 a PIN zadá o 9:30, má
-- v evidencii 9:30; kto sa v niektorý deň neoznačí, ten deň v evidencii nemá.
-- Táto tabuľka drží NÁVRHY na opravu — samotnú dochádzku mení až schválenie
-- manažérom, ktoré zapíše do attendance_events s source='manual'.

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_requests (
  id            serial PRIMARY KEY,
  staff_id      integer NOT NULL REFERENCES staff(id),
  -- 'late_pin' | 'missing_day'
  type          varchar(20) NOT NULL,
  target_date   date NOT NULL,
  claimed_in    timestamptz NOT NULL,
  claimed_out   timestamptz,
  note          varchar(300) NOT NULL DEFAULT '',
  -- 'pending' | 'approved' | 'rejected'
  status        varchar(12) NOT NULL DEFAULT 'pending',
  reviewed_by   integer REFERENCES staff(id),
  reviewed_at   timestamptz,
  review_note   varchar(300) NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_requests_status_idx
  ON attendance_requests (status, created_at);

CREATE INDEX IF NOT EXISTS attendance_requests_staff_idx
  ON attendance_requests (staff_id, target_date);

COMMIT;

-- Overenie:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'attendance_requests' ORDER BY ordinal_position;
