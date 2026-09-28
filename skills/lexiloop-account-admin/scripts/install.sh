#!/usr/bin/env sh
set -eu

skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination_root=${1:-"${CODEX_HOME:-$HOME/.codex}/skills"}
destination="$destination_root/lexiloop-account-admin"

mkdir -p "$destination_root"
if [ -e "$destination" ]; then
  echo "refusing to overwrite existing skill: $destination" >&2
  exit 1
fi

cp -R "$skill_dir" "$destination"
echo "installed lexiloop-account-admin at $destination"
