CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  winner_player_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  CONSTRAINT matches_mode_chk CHECK (mode IN ('pva', 'online'))
);

CREATE TABLE IF NOT EXISTS match_players (
  id BIGSERIAL PRIMARY KEY,
  match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  shots INTEGER NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT match_players_shots_chk CHECK (shots >= 0),
  CONSTRAINT match_players_nickname_len_chk CHECK (char_length(nickname) BETWEEN 1 AND 64),
  CONSTRAINT match_players_unique_per_match UNIQUE (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  ip TEXT,
  socket_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_events_room_id ON match_events(room_id);
CREATE INDEX IF NOT EXISTS idx_match_events_created_at ON match_events(created_at);
CREATE INDEX IF NOT EXISTS idx_match_events_room_created_at ON match_events(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_events_payload_gin ON match_events USING GIN (payload);
CREATE INDEX IF NOT EXISTS idx_matches_status_started_at ON matches(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_mode_started_at ON matches(mode, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at);
CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_player_id ON match_players(player_id);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_event_type_created_at ON security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_ip_created_at ON security_events(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_payload_gin ON security_events USING GIN (payload);
