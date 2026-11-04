#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf '%s\n' 'usage: bash deploy/host/bootstrap.sh --check|--apply --config <path>' >&2
  exit 2
}

mode=''
config=''
while (($#)); do
  case "$1" in
    --check|--apply)
      [[ -z "$mode" ]] || usage
      mode="$1"
      shift
      ;;
    --config)
      [[ $# -ge 2 && -z "$config" ]] || usage
      config="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ -n "$mode" && -n "$config" ]] || usage

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

[[ "$(uname -s 2>/dev/null || true)" == Linux ]] || fail host_os_unsupported
[[ -r /etc/os-release ]] || fail host_os_identity_unavailable
python_path="$(command -v python3 || true)"
systemctl_path="$(command -v systemctl || true)"
docker_path="$(command -v docker || true)"
[[ -n "$python_path" && -x "$python_path" ]] || fail python3_unavailable
[[ -n "$systemctl_path" && -x "$systemctl_path" ]] || fail systemd_unavailable
[[ -n "$docker_path" && -x "$docker_path" ]] || fail docker_unavailable
[[ -r "$config" ]] || fail deployment_config_unavailable

if ! PYTHONPATH="$script_root" python3 "$script_root/scripts/deploy_config.py" --target "$config" >/dev/null 2>&1; then
  fail deployment_target_invalid
fi

environment="$(PYTHONPATH="$script_root" python3 - "$config" <<'PY'
import sys
from pathlib import Path
from scripts.deploy_config import load_deploy_config

print(load_deploy_config(Path(sys.argv[1])).environment)
PY
)"
secrets_dir="$(PYTHONPATH="$script_root" python3 - "$config" <<'PY'
import sys
from pathlib import Path
from scripts.deploy_config import load_deploy_config

print(load_deploy_config(Path(sys.argv[1])).secrets_dir)
PY
)"
state_dir="$(PYTHONPATH="$script_root" python3 - "$config" <<'PY'
import sys
from pathlib import Path
from scripts.deploy_config import load_deploy_config

print(load_deploy_config(Path(sys.argv[1])).state_dir)
PY
)"
[[ "$secrets_dir" == "/etc/dayforge/$environment/secrets" ]] || fail secrets_path_outside_managed_root
[[ "$state_dir" == "/srv/dayforge/$environment/state" ]] || fail state_path_outside_managed_root

machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) host_platform='linux/amd64' ;;
  aarch64|arm64) host_platform='linux/arm64' ;;
  *) fail host_cpu_unsupported ;;
esac
target_platform="$(PYTHONPATH="$script_root" python3 - "$config" <<'PY'
import sys
from pathlib import Path
from scripts.deploy_config import load_deploy_config

print(load_deploy_config(Path(sys.argv[1])).platform)
PY
)"
[[ "$host_platform" == "$target_platform" ]] || fail host_platform_mismatch

compose_version="$(docker compose version --short 2>/dev/null || true)"
[[ -n "$compose_version" ]] || fail docker_compose_v2_unavailable
docker info >/dev/null 2>&1 || fail docker_daemon_unavailable
[[ -d /run/systemd/system ]] || fail systemd_not_running

if [[ -e /run/systemd/timesync/synchronized ]]; then
  clock_synced=1
else
  clock_synced="$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)"
fi
[[ "$clock_synced" == 1 || "${clock_synced,,}" == yes ]] || fail host_clock_unsynchronized

if [[ "$mode" == --check ]]; then
  os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
  os_like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
  [[ "$os_id" == debian || "$os_id" == ubuntu || " $os_like " == *" debian "* ]] || fail host_distribution_unsupported
  printf '%s\n' "bootstrap_check_ok platform=$host_platform compose=$compose_version"
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || fail bootstrap_requires_root
os_id="$(. /etc/os-release; printf '%s' "${ID:-}")"
os_like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
[[ "$os_id" == debian || "$os_id" == ubuntu || " $os_like " == *" debian "* ]] || fail host_distribution_unsupported

install -d -m 0700 "/etc/dayforge/$environment" /etc/dayforge/edge "$secrets_dir" "$state_dir" "/srv/dayforge/releases"
install -d -m 0755 "$state_dir/edge-maintenance"
ensure_network() {
  network_name="$1"
  if docker network inspect "$network_name" >/dev/null 2>&1; then
    network_owner="$(docker network inspect --format '{{ index .Labels "dayforge.managed" }}' "$network_name" 2>/dev/null || true)"
    [[ "$network_owner" == yes ]] || fail docker_network_identity_conflict
  else
    docker network create --label dayforge.managed=yes "$network_name" >/dev/null 2>&1 || fail docker_network_create_failed
  fi
}
ensure_network dayforge-staging-ingress
ensure_network dayforge-production-ingress
install -m 0644 "$script_root/deploy/systemd/dayforge-app@.service" /etc/systemd/system/dayforge-app@.service
install -m 0644 "$script_root/deploy/systemd/dayforge-health@.service" /etc/systemd/system/dayforge-health@.service
install -m 0644 "$script_root/deploy/systemd/dayforge-health@.timer" /etc/systemd/system/dayforge-health@.timer
install -m 0644 "$script_root/deploy/systemd/dayforge-backup@.service" /etc/systemd/system/dayforge-backup@.service
install -m 0644 "$script_root/deploy/systemd/dayforge-backup@.timer" /etc/systemd/system/dayforge-backup@.timer
install -m 0644 "$script_root/deploy/systemd/dayforge-backup-check@.service" /etc/systemd/system/dayforge-backup-check@.service
install -m 0644 "$script_root/deploy/systemd/dayforge-backup-check@.timer" /etc/systemd/system/dayforge-backup-check@.timer
systemctl daemon-reload
systemctl enable docker.service >/dev/null 2>&1 || fail docker_service_enable_failed
printf '%s\n' "bootstrap_apply_ok environment=$environment platform=$host_platform compose=$compose_version"
