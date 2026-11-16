#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -f data/config.json ] || npm run setup
npm start
