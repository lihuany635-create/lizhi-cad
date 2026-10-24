-- LiZhi CAD staging-only PostgreSQL revision storage.
-- THIS FILE IS NOT APPLIED TO PRODUCTION SUPABASE.
-- Database role must be used ONLY after server-verified auth.
-- The authenticated owner is injected into the CURRENT TRANSACTION using
-- SET LOCAL lizhi_cad.owner_id = '<verified account ID>';
-- Custom PostgreSQL settings are forgeable by anyone who can run arbitrary SQL
-- as the application role: NEVER expose this DB role or SQL to untrusted clients.

BEGIN;
CREATE SCHEMA IF NOT EXISTS lizhi_cad;
REVOKE ALL ON SCHEMA lizhi_cad FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS lizhi_cad.drawing_heads (
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  drawing_id text NOT NULL CHECK (drawing_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,drawing_id),
  CHECK ((revision=0 AND sha256 IS NULL) OR (revision>0 AND sha256 ~ '^[a-f0-9]{64}$'))
);

CREATE TABLE IF NOT EXISTS lizhi_cad.drawing_revisions (
  owner_id text NOT NULL,
  drawing_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  dxf bytea NOT NULL CHECK (octet_length(dxf) BETWEEN 30 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,drawing_id,revision),
  FOREIGN KEY (owner_id,drawing_id)
    REFERENCES lizhi_cad.drawing_heads(owner_id,drawing_id)
    ON DELETE RESTRICT
);

ALTER TABLE lizhi_cad.drawing_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lizhi_cad.drawing_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lizhi_cad.drawing_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE lizhi_cad.drawing_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cad_heads_owner ON lizhi_cad.drawing_heads;
CREATE POLICY cad_heads_owner ON lizhi_cad.drawing_heads
  FOR ALL TO PUBLIC
  USING (owner_id = current_setting('lizhi_cad.owner_id',true))
  WITH CHECK (owner_id = current_setting('lizhi_cad.owner_id',true));

DROP POLICY IF EXISTS cad_revisions_owner ON lizhi_cad.drawing_revisions;
CREATE POLICY cad_revisions_owner ON lizhi_cad.drawing_revisions
  FOR ALL TO PUBLIC
  USING (owner_id = current_setting('lizhi_cad.owner_id',true))
  WITH CHECK (owner_id = current_setting('lizhi_cad.owner_id',true));

-- SECURITY INVOKER: still obeys RLS and ordinary table privileges.
-- Uses one row lock to serialize concurrent workers even across hosts.
CREATE OR REPLACE FUNCTION lizhi_cad.save_revision(
    p_drawing_id text,p_expected_revision integer,p_dxf bytea,p_sha256 text
)
RETURNS TABLE(result_status text,new_revision integer,digest text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,lizhi_cad
AS $$
DECLARE
    v_owner text := current_setting('lizhi_cad.owner_id',true);
    v_revision integer;
    v_sha text;
BEGIN
    IF v_owner IS NULL OR v_owner !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' THEN
      RAISE EXCEPTION 'verified owner context required' USING ERRCODE='28000';
    END IF;
    IF p_drawing_id IS NULL OR p_drawing_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' THEN
      RAISE EXCEPTION 'invalid drawing identifier' USING ERRCODE='22023';
    END IF;
    IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
      RAISE EXCEPTION 'invalid expected revision' USING ERRCODE='22023';
    END IF;
    IF p_dxf IS NULL OR octet_length(p_dxf) < 30 OR octet_length(p_dxf) > 8388608 THEN
      RAISE EXCEPTION 'invalid DXF size' USING ERRCODE='22023';
    END IF;
    v_sha := encode(digest(p_dxf,'sha256'),'hex');
    IF p_sha256 IS NULL OR p_sha256 <> v_sha THEN
      RAISE EXCEPTION 'DXF digest mismatch' USING ERRCODE='22023';
    END IF;

    INSERT INTO lizhi_cad.drawing_heads(owner_id,drawing_id)
      VALUES(v_owner,p_drawing_id)
      ON CONFLICT (owner_id,drawing_id) DO NOTHING;

    SELECT h.revision INTO v_revision
      FROM lizhi_cad.drawing_heads h
      WHERE h.owner_id=v_owner AND h.drawing_id=p_drawing_id
      FOR UPDATE;
    IF v_revision IS NULL THEN
      RAISE EXCEPTION 'drawing owner policy denied operation' USING ERRCODE='42501';
    END IF;
    IF v_revision <> p_expected_revision THEN
      RETURN QUERY SELECT 'VERSION_CONFLICT'::text,v_revision,
         (SELECT h.sha256 FROM lizhi_cad.drawing_heads h
           WHERE h.owner_id=v_owner AND h.drawing_id=p_drawing_id);
      RETURN;
    END IF;

    INSERT INTO lizhi_cad.drawing_revisions(owner_id,drawing_id,revision,sha256,dxf)
      VALUES(v_owner,p_drawing_id,v_revision+1,v_sha,p_dxf);
    UPDATE lizhi_cad.drawing_heads h
      SET revision=v_revision+1,sha256=v_sha,updated_at=now()
      WHERE h.owner_id=v_owner AND h.drawing_id=p_drawing_id;

    RETURN QUERY SELECT 'SAVED'::text,v_revision+1,v_sha;
END;
$$;

CREATE OR REPLACE FUNCTION lizhi_cad.load_revision(
  p_drawing_id text,p_revision integer DEFAULT NULL
)
RETURNS TABLE(drawing_id text,revision integer,sha256 text,dxf bytea)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,lizhi_cad
AS $$
DECLARE v_owner text := current_setting('lizhi_cad.owner_id',true);
BEGIN
  IF v_owner IS NULL OR v_owner !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' THEN
    RAISE EXCEPTION 'verified owner context required' USING ERRCODE='28000';
  END IF;
  RETURN QUERY SELECT r.drawing_id,r.revision,r.sha256,r.dxf
  FROM lizhi_cad.drawing_revisions r
  WHERE r.owner_id=v_owner AND r.drawing_id=p_drawing_id
    AND r.revision=COALESCE(p_revision,
       (SELECT h.revision FROM lizhi_cad.drawing_heads h
          WHERE h.owner_id=v_owner AND h.drawing_id=p_drawing_id));
END;
$$;

CREATE OR REPLACE FUNCTION lizhi_cad.list_revisions(p_drawing_id text)
RETURNS TABLE(revision integer,sha256 text,created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,lizhi_cad
AS $$
DECLARE v_owner text := current_setting('lizhi_cad.owner_id',true);
BEGIN
  IF v_owner IS NULL OR v_owner !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' THEN
    RAISE EXCEPTION 'verified owner context required' USING ERRCODE='28000';
  END IF;
  RETURN QUERY SELECT r.revision,r.sha256,r.created_at
    FROM lizhi_cad.drawing_revisions r
    WHERE r.owner_id=v_owner AND r.drawing_id=p_drawing_id
    ORDER BY r.revision;
END;
$$;

-- Never grant SQL execution or table access to public/anonymous browser roles.
REVOKE ALL ON ALL TABLES IN SCHEMA lizhi_cad FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lizhi_cad FROM PUBLIC;
COMMIT;
