#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
dsh_modules=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules

mkdir -p "$runtime_home"

# A named volume is empty on first boot. Seed common state first, then add any
# newly introduced profile without replacing existing settings or sessions.
if [ ! -d "$runtime_home/profiles" ]; then
  cp -a "$seed_home/." "$runtime_home/"
fi

for profile in web headless dev; do
  if [ ! -f "$runtime_home/profiles/$profile/package.json" ]; then
    mkdir -p "$runtime_home/profiles"
    cp -a "$seed_home/profiles/$profile" "$runtime_home/profiles/$profile"
  fi
done

# Upgrade existing persistent profiles without deleting settings or sessions.
node /opt/bankops/docker/migrate-profile.mjs "$runtime_home"

# pnpm stores local link dependencies as relative symlinks. Moving the seeded
# profile from /opt/dsh-seed to a persistent /data volume changes what those
# links resolve to, so repair them against the immutable plugins in the image.
for profile in web headless dev; do
  modules="$runtime_home/profiles/$profile/node_modules"
  [ -d "$runtime_home/profiles/$profile" ] || continue

  mkdir -p "$modules/@bankops"
  ln -sfn /opt/bankops/plugins/bankops-core "$modules/@bankops/dsh-core"
  ln -sfn /opt/bankops/plugins/bankops-change-impact "$modules/@bankops/dsh-change-impact"

  case "$profile" in
    web)
      mkdir -p "$modules/@omdsh-dev" "$modules/@dsh-community"
      ln -sfn /opt/bankops/plugins/external/dsh-genui "$modules/@omdsh-dev/dsh-genui"
      ln -sfn /opt/bankops/plugins/external/dsh-deeplink "$modules/@dsh-community/dsh-deeplink"
      ln -sfn "$dsh_modules" /opt/bankops/plugins/external/dsh-genui/node_modules
      ln -sfn "$dsh_modules" /opt/bankops/plugins/external/dsh-deeplink/node_modules
      ;;
    dev)
      mkdir -p "$modules/@deepseek-ai"
      ln -sfn /opt/bankops/plugins/external/dsh-context-doctor "$modules/dsh-context-doctor"
      ln -sfn /opt/bankops/plugins/external/dsh-plugin-check "$modules/@deepseek-ai/dsh-plugin-check"
      ln -sfn /opt/bankops/plugins/external/dsh-security-audit "$modules/@deepseek-ai/dsh-security-audit"
      ln -sfn "$dsh_modules" /opt/bankops/plugins/external/dsh-context-doctor/node_modules
      ln -sfn "$dsh_modules" /opt/bankops/plugins/external/dsh-plugin-check/node_modules
      ln -sfn "$dsh_modules" /opt/bankops/plugins/external/dsh-security-audit/node_modules
      ;;
  esac
done

if [ "${BANKOPS_WEB_PROXY:-0}" = "1" ]; then
  node /opt/bankops/docker/web-proxy.mjs &
fi

exec "$@"
