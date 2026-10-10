#!/bin/sh
# Install the notarized Apple Silicon ZTC desktop and its owned command.
# Uses macOS system tools only; never runs npm, installs Node, or changes PATH.
set -eu
umask 077
channel=stable
app_dir=${HOME:?HOME is required}/Applications
bin_dir=$HOME/.local/bin
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preview) channel=preview ;;
    --app-dir|--bin-dir)
      option=$1; shift; [ "$#" -gt 0 ] || { printf 'ZTC install: %s needs a directory\n' "$option" >&2; exit 1; }
      if [ "$option" = --app-dir ]; then app_dir=$1; else bin_dir=$1; fi ;;
    --help|-h) printf '%s\n' 'Usage: install-ztc.sh [--preview] [--app-dir ABSOLUTE_DIR] [--bin-dir ABSOLUTE_DIR]' 'Defaults: ~/Applications/ztc.app and ~/.local/bin/ztc. Existing installations are never overwritten.'; exit 0 ;;
    *) printf 'ZTC install: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
fail() { printf 'ZTC install: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'this release requires macOS on Apple Silicon (arm64).'
[ "$(id -u)" != 0 ] || fail 'run as your own user, without sudo.'
for directory in "$app_dir" "$bin_dir"; do
  case "$directory" in /*) ;; *) fail 'installation directories must be absolute.' ;; esac
  case "$directory" in *'
'*) fail 'installation directories must not contain newlines.' ;; esac
done
target=$app_dir/ztc.app
command_path=$bin_dir/ztc
[ ! -e "$target" ] && [ ! -L "$target" ] || fail 'ztc.app already exists; use its Updates window or choose another --app-dir.'
[ ! -e "$command_path" ] && [ ! -L "$command_path" ] || fail 'an existing ztc command would be replaced; choose another --bin-dir.'
for tool in curl plutil shasum codesign spctl hdiutil ditto mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "required macOS tool is missing: $tool"; done
work=$(mktemp -d "${TMPDIR:-/tmp}/ztc-install.XXXXXX")
mounted=false
created=false
completed=false
cleanup() {
  result=$?
  trap - 0 HUP INT TERM
  if [ "$mounted" = true ]; then hdiutil detach "$work/mount" -quiet >/dev/null 2>&1 || true; fi
  if [ "$completed" != true ] && [ "$created" = true ]; then rm -rf "$target"; fi
  rm -rf "$work"
  if [ "$result" -ne 0 ]; then printf '%s\n' 'ZTC install: verification or installation failed; no existing installation was replaced.' >&2; fi
  exit "$result"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --max-filesize "$3" --output "$2" "$1"; }
manifest=$work/release.json
fetch "https://epoch-ml.github.io/ztc-releases/$channel/release.json" "$manifest" 262144 || fail 'no verified release is published for this channel yet.'
[ "$(wc -c < "$manifest" | tr -d ' ')" -le 262144 ] || fail 'release manifest exceeds its size limit.'
field() { plutil -extract "$1" raw -o - "${2:-$manifest}"; }
[ "$(field schemaVersion)" = 1 ] && [ "$(field product)" = ZTC ] || fail 'unsupported release manifest.'
[ "$(field channel)" = "$channel" ] && [ "$(field platform)" = darwin-arm64 ] || fail 'release channel or platform mismatch.'
[ "$(field bundle.identifier)" = dev.zerg.zterm ] && [ "$(field bundle.appName)" = ztc.app ] || fail 'release bundle identity mismatch.'
[ "$(field trust.notarized)" = true ] && [ "$(field trust.appleTeamId)" = JLNC3N65LF ] || fail 'release is not notarized by the ZTC signing team.'
[ "$(field runtime.nodeVersion)" = 22.23.2 ] && [ "$(field npm.name)" = @zergai/ztc ] || fail 'release runtime identity mismatch.'
version=$(field version)
npm_version=$(field npm.version)
for value in "$version" "$npm_version"; do printf '%s\n' "$value" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$' || fail 'release version is invalid.'; done
case "$channel:$version" in stable:*-*) fail 'stable desktop release cannot be a prerelease.' ;; esac
source_sha=$(field sourceSha)
printf '%s\n' "$source_sha" | grep -Eq '^[0-9a-f]{40}$' || fail 'release source identity is invalid.'
runtime_sha=$(field runtime.manifestSha256)
dmg_sha=$(field assets.dmg.sha256)
archive_sha=$(field assets.archive.sha256)
for value in "$runtime_sha" "$dmg_sha" "$archive_sha"; do printf '%s\n' "$value" | grep -Eq '^[0-9a-f]{64}$' || fail 'release checksum is invalid.'; done
if [ "$channel" = stable ]; then tag=ztc-desktop-v$version; else tag=ztc-desktop-preview-v$version; fi
base=https://github.com/Epoch-ML/ztc-releases/releases/download/$tag
dmg_url=$(field assets.dmg.url)
[ "$dmg_url" = "$base/ztc_${version}_aarch64.dmg" ] && [ "$(field assets.archive.url)" = "$base/ztc.app.tar.gz" ] || fail 'release asset escaped its exact repository, tag or filename.'
[ "$(field npm.tarballUrl)" = "https://registry.npmjs.org/@zergai/ztc/-/ztc-$npm_version.tgz" ] || fail 'npm artifact escaped its exact package version.'
printf '%s\n' "$(field npm.integrity)" | grep -Eq '^sha512-[A-Za-z0-9+/]{86}==$' || fail 'npm artifact integrity is invalid.'
[ -n "$(field assets.archive.signature)" ] || fail 'archive signature is missing.'
dmg=$work/ztc.dmg
fetch "$dmg_url" "$dmg" 536870912 || fail 'desktop download failed.'
[ "$(shasum -a 256 "$dmg" | cut -d ' ' -f 1)" = "$dmg_sha" ] || fail 'desktop download checksum mismatch.'
codesign --verify --strict "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg" 2>&1 | grep -F 'source=Notarized Developer ID' >/dev/null || fail 'disk image is not notarized.'
team() { codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
[ "$(team "$dmg")" = JLNC3N65LF ] || fail 'disk image signing team mismatch.'
mkdir "$work/mount"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$work/mount" "$dmg" >/dev/null
mounted=true
app=$work/mount/ztc.app
[ -d "$app" ] && [ ! -L "$app" ] || fail 'disk image has no regular ztc.app bundle.'
codesign --verify --deep --strict "$app"
spctl --assess --type execute --verbose=2 "$app" 2>&1 | grep -F 'source=Notarized Developer ID' >/dev/null || fail 'app is not notarized.'
[ "$(team "$app")" = JLNC3N65LF ] || fail 'app signing team mismatch.'
plist=$app/Contents/Info.plist
[ "$(field CFBundleIdentifier "$plist")" = dev.zerg.zterm ] && [ "$(field CFBundleName "$plist")" = ZTC ] && [ "$(field CFBundleExecutable "$plist")" = ZTerm ] || fail 'downloaded app identity mismatch.'
runtime=$app/Contents/Resources/ztc-runtime.json
[ -f "$runtime" ] && [ ! -L "$runtime" ] || fail 'app has no owned runtime manifest.'
[ "$(shasum -a 256 "$runtime" | cut -d ' ' -f 1)" = "$runtime_sha" ] || fail 'runtime manifest checksum mismatch.'
[ "$(field product "$runtime")" = ZTC ] && [ "$(field platform "$runtime")" = darwin-arm64 ] && [ "$(field source_sha "$runtime")" = "$source_sha" ] && [ "$(field release_version "$runtime")" = "$version" ] || fail 'runtime source or release mismatch.'
[ "$(field agent.version "$runtime")" = "$npm_version" ] && [ "$(field node.version "$runtime")" = v22.23.2 ] || fail 'bundled Node or agent version mismatch.'
[ "$(field node.executable "$runtime")" = Resources/runtime/node ] && [ "$(field agent.entry "$runtime")" = Resources/runtime/ztc/dist/cli_main.js ] && [ "$(field renderer.executable "$runtime")" = MacOS/ZTerm ] || fail 'runtime entry paths mismatch.'
mkdir -p "$app_dir" "$bin_dir"
# mkdir and ln provide no-overwrite admission even if another installer races us.
mkdir "$target" || fail 'app destination already exists.'
created=true
ditto "$app" "$target"
codesign --verify --deep --strict "$target"
quoted=$(printf '%s' "$target/Contents/MacOS/ZTerm" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\nexec '\''%s'\'' --ztc-cli "$@"\n' "$quoted" > "$work/ztc"
chmod 755 "$work/ztc"
# Stage on the command filesystem so the final no-overwrite link is atomic.
command_stage=$(mktemp "$bin_dir/.ztc-install.XXXXXX")
cp "$work/ztc" "$command_stage"
chmod 755 "$command_stage"
if ! ln "$command_stage" "$command_path"; then rm -f "$command_stage"; fail 'command destination already exists.'; fi
rm -f "$command_stage"
completed=true
printf 'Installed ZTC %s (desktop %s) at %s\n' "$npm_version" "$version" "$target"
printf 'Command: %s\n' "$command_path"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to PATH to use ztc from your terminal.\n' "$bin_dir" ;; esac
printf '%s\n' 'Open ztc.app to begin. Existing ZTerm.app and ~/.ztc data were left intact.'
