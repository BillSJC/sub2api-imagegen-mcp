#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SERVER_NAME="sub2api_imagegen"
DEFAULT_REPOSITORY="https://github.com/BillSJC/sub2api-imagegen-mcp.git"
MINIMUM_NODE_VERSION="20.19.0"

base_url="${SUB2API_BASE_URL-}"
key_file="${SUB2API_API_KEY_FILE-}"
output_dir="${SUB2API_IMAGE_OUTPUT_DIR-}"
model="${SUB2API_IMAGE_MODEL-gpt-image-2}"
timeout_ms="${SUB2API_TIMEOUT_MS-600000}"
install_dir="${SUB2API_MCP_INSTALL_DIR-}"
repository="${SUB2API_MCP_REPOSITORY_URL-$DEFAULT_REPOSITORY}"
repository_ref="${SUB2API_MCP_REF-main}"
codex_bin="${SUB2API_MCP_CODEX_BIN-}"
non_interactive=0
secret_temp=""
config_backup=""
config_existed=0
config_touched=0
config_committed=0

log() {
  printf '[sub2api-imagegen-mcp] %s\n' "$*"
}

die() {
  printf '[sub2api-imagegen-mcp] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash install.sh [options]

Options:
  --base-url URL       Sub2API origin or /v1 base URL
  --api-key-file PATH  External private API key file
  --install-dir PATH   Installation directory
  --output-dir PATH    Generated image directory
  --model MODEL        Image model (default: gpt-image-2)
  --timeout-ms MS      Upstream timeout, 1000-900000 (default: 600000)
  --repository URL     Git repository used by bootstrap mode
  --ref NAME           Git branch used by bootstrap mode (default: main)
  --non-interactive    Never prompt; require URL and key input from env/options
  -h, --help           Show this help

Never pass the API key as a command-line argument. For unattended installation,
set SUB2API_API_KEY or point SUB2API_API_KEY_FILE at an existing mode-0600 file.
EOF
}

require_absolute_path() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path: $2" ;;
  esac
}

reject_control_characters() {
  case "$2" in
    *$'\n'* | *$'\r'*) die "$1 must not contain line breaks." ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

is_source_tree() {
  local candidate="$1"
  [[ -f "$candidate/package.json" ]] &&
    [[ -f "$candidate/src/index.ts" ]] &&
    [[ -f "$candidate/scripts/configure-codex.mjs" ]] &&
    grep -q '"name": "sub2api-imagegen-mcp"' "$candidate/package.json"
}

prompt_value() {
  local prompt="$1"
  local secret="${2-0}"
  local value=""
  if [[ "$non_interactive" -eq 1 ]] || [[ ! -r /dev/tty ]]; then
    die "Missing required input in non-interactive mode: $prompt"
  fi
  printf '%s' "$prompt" >/dev/tty
  if [[ "$secret" -eq 1 ]]; then
    IFS= read -r -s value </dev/tty || die "Failed to read secret from terminal."
    printf '\n' >/dev/tty
  else
    IFS= read -r value </dev/tty || die "Failed to read value from terminal."
  fi
  printf '%s' "$value"
}

restore_config() {
  if [[ "$config_touched" -ne 1 ]] || [[ "$config_committed" -eq 1 ]]; then
    return
  fi
  if [[ "$config_existed" -eq 1 ]] && [[ -f "$config_backup" ]]; then
    cp -p "$config_backup" "$config_path"
    log "Restored Codex configuration from $config_backup"
  elif [[ "$config_existed" -eq 0 ]] && [[ -f "$config_path" ]]; then
    unlink "$config_path"
    log "Removed incomplete Codex configuration."
  fi
}

cleanup() {
  local status=$?
  if [[ -n "$secret_temp" ]] && [[ -f "$secret_temp" ]]; then
    unlink "$secret_temp" || true
  fi
  if [[ "$status" -ne 0 ]]; then
    restore_config || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      [[ $# -ge 2 ]] || die "--base-url requires a value."
      base_url="$2"
      shift 2
      ;;
    --api-key-file)
      [[ $# -ge 2 ]] || die "--api-key-file requires a value."
      key_file="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || die "--install-dir requires a value."
      install_dir="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || die "--output-dir requires a value."
      output_dir="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || die "--model requires a value."
      model="$2"
      shift 2
      ;;
    --timeout-ms)
      [[ $# -ge 2 ]] || die "--timeout-ms requires a value."
      timeout_ms="$2"
      shift 2
      ;;
    --repository)
      [[ $# -ge 2 ]] || die "--repository requires a value."
      repository="$2"
      shift 2
      ;;
    --ref)
      [[ $# -ge 2 ]] || die "--ref requires a value."
      repository_ref="$2"
      shift 2
      ;;
    --non-interactive)
      non_interactive=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

api_key_value="${SUB2API_API_KEY-}"
unset SUB2API_API_KEY || true
if [[ -n "$api_key_value" ]]; then
  reject_control_characters "SUB2API_API_KEY" "$api_key_value"
fi

[[ -n "${HOME-}" ]] || die "HOME is not set."
require_absolute_path "HOME" "$HOME"

xdg_config_home="${XDG_CONFIG_HOME-$HOME/.config}"
xdg_data_home="${XDG_DATA_HOME-$HOME/.local/share}"
codex_home="${CODEX_HOME-$HOME/.codex}"
require_absolute_path "XDG_CONFIG_HOME" "$xdg_config_home"
require_absolute_path "XDG_DATA_HOME" "$xdg_data_home"
require_absolute_path "CODEX_HOME" "$codex_home"

if [[ -z "$key_file" ]]; then
  key_file="$xdg_config_home/sub2api-imagegen-mcp/sub2api-api.key"
fi
if [[ -z "$output_dir" ]]; then
  output_dir="$HOME/Pictures/Sub2API"
fi

script_dir=""
if [[ -n "${BASH_SOURCE[0]-}" ]] && [[ -f "${BASH_SOURCE[0]}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [[ -z "$install_dir" ]]; then
  if [[ -n "$script_dir" ]] && is_source_tree "$script_dir"; then
    install_dir="$script_dir"
  else
    install_dir="$xdg_data_home/sub2api-imagegen-mcp"
  fi
fi

for entry in \
  "install directory:$install_dir" \
  "API key file:$key_file" \
  "output directory:$output_dir"; do
  require_absolute_path "${entry%%:*}" "${entry#*:}"
  reject_control_characters "${entry%%:*}" "${entry#*:}"
done
reject_control_characters "Sub2API base URL" "$base_url"
reject_control_characters "model" "$model"
reject_control_characters "timeout" "$timeout_ms"
reject_control_characters "repository" "$repository"
reject_control_characters "repository ref" "$repository_ref"
if [[ ! "$timeout_ms" =~ ^[0-9]{1,6}$ ]]; then
  die "Timeout must be an integer between 1000 and 900000 milliseconds."
fi
timeout_ms="$((10#$timeout_ms))"
if ((timeout_ms < 1000 || timeout_ms > 900000)); then
  die "Timeout must be between 1000 and 900000 milliseconds."
fi
tool_timeout_sec="$(((timeout_ms + 999) / 1000 + 60))"

require_command node
require_command npm
node_path="$(node -p 'process.execPath')"
npm_bin="$(command -v npm)"
require_absolute_path "Node executable" "$node_path"
node -e '
const current = process.versions.node.split(".").map(Number);
const minimum = process.argv[1].split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  if (current[index] > minimum[index]) process.exit(0);
  if (current[index] < minimum[index]) process.exit(1);
}
' "$MINIMUM_NODE_VERSION" ||
  die "Node.js $MINIMUM_NODE_VERSION or newer is required; found $(node --version)."

if [[ -z "$codex_bin" ]]; then
  require_command codex
  codex_bin="$(command -v codex)"
fi
[[ -x "$codex_bin" ]] || die "Codex executable is not runnable: $codex_bin"
require_absolute_path "Codex executable" "$codex_bin"

if [[ -z "$base_url" ]]; then
  base_url="$(prompt_value 'Sub2API base URL (for example https://api.example.com/v1): ')"
fi
[[ -n "$base_url" ]] || die "Sub2API base URL cannot be empty."
reject_control_characters "Sub2API base URL" "$base_url"

if [[ -L "$install_dir" ]]; then
  die "Install directory must not be a symbolic link: $install_dir"
fi

if is_source_tree "$install_dir"; then
  install_dir="$(cd "$install_dir" && pwd -P)"
  if [[ -d "$install_dir/.git" ]] && [[ "${SUB2API_MCP_NO_UPDATE-0}" != "1" ]]; then
    require_command git
    origin_url="$(git -C "$install_dir" remote get-url origin)" ||
      die "Install repository does not have an origin remote."
    if [[ "$repository" == "$DEFAULT_REPOSITORY" ]]; then
      case "$origin_url" in
        "$DEFAULT_REPOSITORY" | \
          "git@github.com:BillSJC/sub2api-imagegen-mcp.git" | \
          "ssh://git@github.com/BillSJC/sub2api-imagegen-mcp.git") ;;
        *) die "Install repository origin is unexpected: $origin_url" ;;
      esac
    elif [[ "$origin_url" != "$repository" ]]; then
      die "Install repository origin does not match --repository."
    fi
    [[ -z "$(git -C "$install_dir" status --porcelain --untracked-files=no)" ]] ||
      die "Install repository has tracked changes; commit or discard them before updating."
    current_branch="$(git -C "$install_dir" branch --show-current)"
    [[ "$current_branch" == "$repository_ref" ]] ||
      die "Install repository must be on '$repository_ref'; found '$current_branch'."
    log "Updating existing installation from origin/$repository_ref..."
    git -C "$install_dir" fetch --prune origin "$repository_ref"
    git -C "$install_dir" merge --ff-only "origin/$repository_ref"
  fi
else
  require_command git
  if [[ -e "$install_dir" ]] && [[ ! -d "$install_dir" ]]; then
    die "Install path exists and is not a directory: $install_dir"
  fi
  if [[ -d "$install_dir" ]] && [[ -n "$(ls -A "$install_dir")" ]]; then
    die "Install directory is non-empty and is not this MCP repository: $install_dir"
  fi
  mkdir -p "$(dirname "$install_dir")"
  log "Cloning public repository into $install_dir..."
  git clone --branch "$repository_ref" --single-branch "$repository" "$install_dir"
  install_dir="$(cd "$install_dir" && pwd -P)"
  is_source_tree "$install_dir" || die "Cloned repository is missing expected MCP files."
fi

log "Installing locked dependencies and building MCP..."
(
  cd "$install_dir"
  "$npm_bin" ci
  "$npm_bin" run build
  if [[ -d .git ]]; then
    "$npm_bin" run secrets:check
  fi
  "$npm_bin" prune --omit=dev
)
[[ -f "$install_dir/dist/index.js" ]] || die "Build did not produce dist/index.js."
"$node_path" "$install_dir/dist/index.js" --version

key_dir="$(dirname "$key_file")"
mkdir -p "$key_dir"
chmod 700 "$key_dir"
if [[ -L "$key_file" ]]; then
  die "API key file must not be a symbolic link: $key_file"
fi
if [[ -e "$key_file" ]] && [[ ! -f "$key_file" ]]; then
  die "API key path must be a regular file: $key_file"
fi
if [[ -n "$api_key_value" ]]; then
  secret_temp="$(mktemp "$key_dir/.sub2api-api.key.XXXXXX")"
  chmod 600 "$secret_temp"
  printf '%s\n' "$api_key_value" >"$secret_temp"
  mv -f "$secret_temp" "$key_file"
  secret_temp=""
elif [[ ! -s "$key_file" ]]; then
  api_key_value="$(prompt_value 'Sub2API API Key: ' 1)"
  [[ -n "$api_key_value" ]] || die "Sub2API API Key cannot be empty."
  reject_control_characters "Sub2API API Key" "$api_key_value"
  secret_temp="$(mktemp "$key_dir/.sub2api-api.key.XXXXXX")"
  chmod 600 "$secret_temp"
  printf '%s\n' "$api_key_value" >"$secret_temp"
  mv -f "$secret_temp" "$key_file"
  secret_temp=""
fi
unset api_key_value || true
[[ -f "$key_file" ]] && [[ ! -L "$key_file" ]] ||
  die "API key file was not created as a regular file: $key_file"
chmod 600 "$key_file"

mkdir -p "$output_dir"
chmod 700 "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
key_file="$(cd "$key_dir" && pwd -P)/$(basename "$key_file")"

log "Validating runtime configuration without making an image request..."
SUB2API_BASE_URL="$base_url" \
  SUB2API_API_KEY_FILE="$key_file" \
  SUB2API_IMAGE_OUTPUT_DIR="$output_dir" \
  SUB2API_IMAGE_MODEL="$model" \
  SUB2API_TIMEOUT_MS="$timeout_ms" \
  "$node_path" "$install_dir/dist/index.js" --check-config

mkdir -p "$codex_home"
chmod 700 "$codex_home"
codex_home="$(cd "$codex_home" && pwd -P)"
config_path="$codex_home/config.toml"
if [[ -L "$config_path" ]]; then
  die "Codex config must not be a symbolic link: $config_path"
fi
if [[ -e "$config_path" ]] && [[ ! -f "$config_path" ]]; then
  die "Codex config must be a regular file: $config_path"
fi
if [[ -f "$config_path" ]]; then
  config_existed=1
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  config_backup="$codex_home/config.toml.backup.$timestamp.$$"
  cp -p "$config_path" "$config_backup"
  chmod 600 "$config_backup"
  log "Backed up Codex configuration to $config_backup"
fi

export CODEX_HOME="$codex_home"
config_touched=1
if "$codex_bin" mcp get "$SERVER_NAME" >/dev/null 2>&1; then
  "$codex_bin" mcp remove "$SERVER_NAME"
fi
"$codex_bin" mcp add "$SERVER_NAME" \
  --env "SUB2API_BASE_URL=$base_url" \
  --env "SUB2API_API_KEY_FILE=$key_file" \
  --env "SUB2API_IMAGE_OUTPUT_DIR=$output_dir" \
  --env "SUB2API_IMAGE_MODEL=$model" \
  --env "SUB2API_TIMEOUT_MS=$timeout_ms" \
  -- "$node_path" "$install_dir/dist/index.js"

"$node_path" "$install_dir/scripts/configure-codex.mjs" \
  --config "$config_path" \
  --cwd "$install_dir" \
  --server "$SERVER_NAME" \
  --tool-timeout-sec "$tool_timeout_sec"
chmod 600 "$config_path"
"$codex_bin" mcp get "$SERVER_NAME" --json >/dev/null
config_committed=1

log "Installation complete."
log "MCP server: $SERVER_NAME"
log "Install directory: $install_dir"
log "API key file: $key_file"
log "Image output directory: $output_dir"
log "Timeouts: Sub2API ${timeout_ms} ms; Codex tool ${tool_timeout_sec} seconds"
log "Restart ChatGPT/Codex, start a new task, and run /mcp to confirm imagegen."
