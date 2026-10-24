#!/usr/bin/env bash
# Ephemeral PostgreSQL 16 container only. Test two independent DB connections.
set -euo pipefail
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=cad_ci}"
: "${PGUSER:=lizhi_cad_ci_app}"
: "${PGPASSWORD:=ci_runtime_test_only}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

payload="convert_to(E'0\\nSECTION\\n2\\nENTITIES\\n0\\nLINE\\n10\\n0\\n20\\n0\\n11\\n100\\n21\\n60\\n0\\nENDSEC\\n0\\nEOF\\n','UTF8')"
sqlA="BEGIN; SET LOCAL lizhi_cad.owner_id='owner_A'; SELECT result_status FROM lizhi_cad.save_revision('race',0,$payload,encode(sha256($payload),'hex')); COMMIT;"
psql -X -qAt -c "$sqlA" > "$tmp/a.txt" 2>"$tmp/a.err" &
pida=$!
psql -X -qAt -c "$sqlA" > "$tmp/b.txt" 2>"$tmp/b.err" &
pidb=$!
wait "$pida"
wait "$pidb"
saved="$(grep -h -c '^SAVED$' "$tmp"/{a,b}.txt | awk '{x+=$1}END{print x+0}')"
conflicts="$(grep -h -c '^VERSION_CONFLICT$' "$tmp"/{a,b}.txt | awk '{x+=$1}END{print x+0}')"
if [[ "$saved" != 1 || "$conflicts" != 1 ]]; then
  echo "Unexpected DB CAS results: saved=$saved conflict=$conflicts"
  exit 1
fi
echo "PASS two independent PostgreSQL connections: 1 saved, 1 CAS conflict"
# New process reads revision 1, verifying that state is NOT tied to a Node process.
reopened="$(psql -X -qAt -c "BEGIN; SET LOCAL lizhi_cad.owner_id='owner_A'; SELECT revision || ':' || encode(sha256(dxf),'hex')=revision::text || ':' || sha256 FROM lizhi_cad.load_revision('race'); COMMIT;")"
if [[ "$reopened" != "t" ]]; then
  echo "Revision failed to reopen with checksum"
  exit 1
fi
echo "PASS separate PostgreSQL process reopened persisted native DXF revision with SHA256"
echo 'LIZHI_CAD_POSTGRES_MULTICONNECTION_CAS_PASS {"saved":1,"conflict":1,"reopened":true,"productionDBUsed":false}'
