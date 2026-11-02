#!/usr/bin/env bash
# Full e2e: bring up stack, bootstrap (sidecar), probe (sidecars), report, teardown.
# Discovers probes/bootstraps/compose overrides automatically:
#   - Top-level probe-*.sh (back-compat for the original ssh/mysql probes)
#   - scenarios/*/probe.sh (per-scenario)
#   - scenarios/*/compose.yml (per-scenario upstream services, merged via `docker compose -f`)
#   - scenarios/*/bootstrap.sh (sourced by bootstrap.sh dispatcher)
#
# Each probe may declare its sidecar image with a first-line comment:
#   # sidecar-image: <image>
# Default sidecar image: alpine:3.19
#
# Host-side docker port mappings can't be reached on this host (firewall);
# all probes run inside sidecar containers attached to the e2e docker network.
set -uo pipefail
cd "$(dirname "$0")"

NETWORK="e2e-docker_e2e"

# Discover probes (deterministic order via sort).
PROBES=()
for p in $(ls probe-*.sh 2>/dev/null | sort); do PROBES+=("$p"); done
for p in $(ls scenarios/*/probe.sh 2>/dev/null | sort); do PROBES+=("$p"); done

# Discover compose overrides.
COMPOSE_FILES=(-f docker-compose.yml)
for f in $(ls scenarios/*/compose.yml 2>/dev/null | sort); do COMPOSE_FILES+=(-f "$f"); done

echo "[discover] ${#PROBES[@]} probe(s): ${PROBES[*]:-<none>}"
echo "[discover] compose files: ${COMPOSE_FILES[*]}"

# Sanity: a top-level `probe-foo.sh` and a `scenarios/foo/probe.sh` would
# both derive label "foo" and silently overwrite RESULTS[foo]. Fail fast.
seen_labels=$(for p in "${PROBES[@]}"; do
  case "$p" in
    scenarios/*/probe.sh) l=${p#scenarios/}; l=${l%/probe.sh} ;;
    *) l=$(basename "$p" .sh | sed 's/^probe-//') ;;
  esac
  echo "$l"
done | sort)
dup_labels=$(echo "$seen_labels" | uniq -d)
if [ -n "$dup_labels" ]; then
  echo "[FAIL] duplicate probe labels: $(echo "$dup_labels" | tr '\n' ' ')"
  echo "       (a top-level probe-<name>.sh and scenarios/<name>/probe.sh collide)"
  exit 2
fi

cleanup() {
  echo "[teardown] docker compose down"
  docker compose "${COMPOSE_FILES[@]}" down -v 2>&1 | tail -3 || true
}
trap cleanup EXIT INT TERM

echo "[step] docker compose up -d (waiting for gated healthcheck)"
if ! docker compose "${COMPOSE_FILES[@]}" up -d --wait --wait-timeout 180 2>&1 | tail -30; then
  echo "[FAIL] compose up failed"
  docker compose "${COMPOSE_FILES[@]}" logs gated | tail -40
  exit 1
fi

echo ""
echo "[step] bootstrap admin API via sidecar curl"
boot_status=0
docker run --rm --network "$NETWORK" \
  -v "$PWD:/tests:ro" \
  curlimages/curl:latest \
  sh /tests/bootstrap.sh || boot_status=$?
if [ $boot_status -ne 0 ]; then
  echo "[FAIL] bootstrap failed (exit $boot_status)"
  docker compose "${COMPOSE_FILES[@]}" logs gated | tail -30
  exit 1
fi

# Run each probe in its declared sidecar image.
declare -A RESULTS=()
LABELS=()
for probe in "${PROBES[@]}"; do
  # scenarios/<name>/probe.sh -> <name>; probe-<name>.sh -> <name>
  case "$probe" in
    scenarios/*/probe.sh)
      label=${probe#scenarios/}
      label=${label%/probe.sh}
      ;;
    *)
      label=$(basename "$probe" .sh | sed 's/^probe-//')
      ;;
  esac
  LABELS+=("$label")
  sidecar=$(grep -m1 '^# sidecar-image:' "$probe" | sed 's/^# sidecar-image: *//' | tr -d '\r')
  sidecar=${sidecar:-alpine:3.19}
  echo ""
  echo "[step] probe $label via sidecar $sidecar (script: $probe)"
  status=0
  docker run --rm --network "$NETWORK" \
    -v "$PWD:/tests:ro" \
    "$sidecar" \
    sh "/tests/$probe" || status=$?
  RESULTS[$label]=$status
done

echo ""
echo "================ E2E RESULT ================"
overall_pass=true
for label in "${LABELS[@]}"; do
  s=${RESULTS[$label]}
  if [ "$s" -eq 0 ]; then
    printf "  %-18s : PASS\n" "$label"
  else
    printf "  %-18s : FAIL (exit %d)\n" "$label" "$s"
    overall_pass=false
  fi
done
echo "============================================"

echo ""
echo "[gated container logs tail]"
docker compose "${COMPOSE_FILES[@]}" logs --tail 30 gated 2>&1 | sed 's/^/  /'

if $overall_pass; then
  echo "[OVERALL] PASS"
  exit 0
else
  echo "[OVERALL] FAIL"
  exit 1
fi
