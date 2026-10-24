\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lizhi_cad.owner_id='owner_A';
DO $$
DECLARE
  sample1 bytea := convert_to(E'0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n100\n21\n60\n0\nENDSEC\n0\nEOF\n','UTF8');
  sample2 bytea := convert_to(E'0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n10\n10\n20\n10\n40\n5\n0\nENDSEC\n0\nEOF\n','UTF8');
  r record;
  stored bytea;
  sha text;
BEGIN
  SELECT * INTO r FROM lizhi_cad.save_revision('cabinet',0,sample1,encode(sha256(sample1),'hex'));
  IF r.result_status<>'SAVED' OR r.new_revision<>1 THEN RAISE EXCEPTION 'v1 save failed'; END IF;
  RAISE NOTICE 'PASS PostgreSQL saved first DXF revision with integrity digest';

  SELECT * INTO r FROM lizhi_cad.save_revision('cabinet',1,sample2,encode(sha256(sample2),'hex'));
  IF r.result_status<>'SAVED' OR r.new_revision<>2 THEN RAISE EXCEPTION 'v2 save failed'; END IF;
  RAISE NOTICE 'PASS PostgreSQL saved v2 while preserving v1';

  SELECT dxf,sha256 INTO stored,sha FROM lizhi_cad.load_revision('cabinet',1);
  IF stored IS DISTINCT FROM sample1 OR sha<>encode(sha256(sample1),'hex') THEN
     RAISE EXCEPTION 'v1 DXF corrupted';
  END IF;
  SELECT dxf,sha256 INTO stored,sha FROM lizhi_cad.load_revision('cabinet');
  IF stored IS DISTINCT FROM sample2 OR sha<>encode(sha256(sample2),'hex') THEN
     RAISE EXCEPTION 'latest DXF corrupted';
  END IF;
  RAISE NOTICE 'PASS version 1 immutable and latest v2 returned across database reads';

  SELECT * INTO r FROM lizhi_cad.save_revision('cabinet',1,sample1,encode(sha256(sample1),'hex'));
  IF r.result_status<>'VERSION_CONFLICT' OR r.new_revision<>2 THEN
    RAISE EXCEPTION 'CAS failure on stale expectedRevision';
  END IF;
  RAISE NOTICE 'PASS stale SQL revision rejected atomically';

  IF (SELECT count(*) FROM lizhi_cad.list_revisions('cabinet'))<>2 THEN
    RAISE EXCEPTION 'history count invalid';
  END IF;
  RAISE NOTICE 'PASS immutable revision history listing';

  BEGIN
    PERFORM * FROM lizhi_cad.save_revision('brokenhash',0,sample1,repeat('0',64));
    RAISE EXCEPTION 'expected hash mismatch was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS invalid DXF digest rejected';
  END;

  BEGIN
    PERFORM * FROM lizhi_cad.save_revision('../escape',0,sample1,encode(sha256(sample1),'hex'));
    RAISE EXCEPTION 'path traversal accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE NOTICE 'PASS path traversal in drawing id rejected';
  END;
END$$;
COMMIT;

BEGIN;
SET LOCAL lizhi_cad.owner_id='owner_B';
DO $$
DECLARE
  b bytea := convert_to(E'0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n5\n21\n5\n0\nENDSEC\n0\nEOF\n','UTF8');
  r record;
BEGIN
  IF (SELECT count(*) FROM lizhi_cad.drawing_heads WHERE drawing_id='cabinet')<>0 THEN
    RAISE EXCEPTION 'cross-owner RLS head leaked';
  END IF;
  IF (SELECT count(*) FROM lizhi_cad.drawing_revisions WHERE drawing_id='cabinet')<>0 THEN
    RAISE EXCEPTION 'cross-owner RLS revision leaked';
  END IF;
  IF (SELECT count(*) FROM lizhi_cad.load_revision('cabinet',NULL))<>0 THEN
    RAISE EXCEPTION 'cross-owner load leaked';
  END IF;
  SELECT * INTO r FROM lizhi_cad.save_revision('cabinet',0,b,encode(sha256(b),'hex'));
  IF r.new_revision<>1 THEN RAISE EXCEPTION 'owner B cannot have independent drawing id'; END IF;
  RAISE NOTICE 'PASS RLS isolates owner A and owner B with identical drawing ID';
END$$;
COMMIT;

-- No authenticated owner setting: even a runtime database role cannot use RPC.
DO $$
BEGIN
  BEGIN
    PERFORM * FROM lizhi_cad.list_revisions('cabinet');
    RAISE EXCEPTION 'unauthenticated role unexpectedly accessed history';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE NOTICE 'PASS missing trusted owner context rejected';
  END;
END$$;
