#!/usr/bin/env bash
# Prochaine version sémantique à partir des commits depuis le dernier tag vX.Y.Z.
#   feat:                      -> mineure
#   type!: ou BREAKING CHANGE  -> majeure (mineure tant que la version est 0.x)
#   tout autre commit          -> correctif
# Pas de release si les seuls commits sont docs/chore/ci/test/style/build.
set -euo pipefail

last=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)
if [ -n "$last" ]; then range="$last..HEAD"; else last="v0.0.0"; range="HEAD"; fi

subjects=$(git log --format=%s "$range")
bodies=$(git log --format=%B "$range")

release=true
if [ -z "$subjects" ]; then
  release=false
elif [ "${MANUAL:-false}" != "true" ] && \
     ! printf '%s\n' "$subjects" | grep -qvE '^(docs|chore|ci|test|style|build)(\([^)]*\))?: |^Merge '; then
  release=false
fi

bump="${BUMP:-auto}"
if [ "$bump" = "auto" ]; then
  bump=patch
  printf '%s\n' "$subjects" | grep -qE '^feat(\([^)]*\))?: ' && bump=minor
  if printf '%s\n' "$subjects" | grep -qE '^[a-z]+(\([^)]*\))?!: ' || printf '%s\n' "$bodies" | grep -q 'BREAKING CHANGE'; then
    bump=major
  fi
fi
[ "${MANUAL:-false}" = "true" ] && release=true

IFS=. read -r major minor patch <<<"${last#v}"
if [ "$bump" = "major" ] && [ "$major" = "0" ]; then bump=minor; fi
case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  *)     patch=$((patch + 1)) ;;
esac
version="$major.$minor.$patch"

echo "Dernier tag : $last · incrément : $bump · release : $release · version : $version"
{
  echo "release=$release"
  echo "version=$version"
  echo "sha=$(git rev-parse HEAD)"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
