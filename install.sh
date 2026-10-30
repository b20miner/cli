#!/usr/bin/env sh
# One-time setup: installs dependencies, builds the native hasher and puts a
# `b20miner` command in ~/.local/bin, so it runs from any folder.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
echo "Installing dependencies…"
npm install --no-audit --no-fund >/dev/null
if [ ! -x native/b20miner-hasher ]; then
  echo "Building the native hasher…"
  npm run --silent build:hasher || echo "No C compiler found: the CLI will use the slower built-in hasher."
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/b20miner" "$HOME/.local/bin/b20miner"
# Make ~/.local/bin visible to new shells (same approach as foundryup: one
# line in the shell's startup file, added only once).
LINE='export PATH="$HOME/.local/bin:$PATH"'
case "$(basename "${SHELL:-sh}")" in
  zsh) RC="$HOME/.zshenv" ;;
  bash) RC="$HOME/.bashrc" ;;
  *) RC="$HOME/.profile" ;;
esac
if ! grep -qs '.local/bin' "$RC"; then
  printf '\n# Added by the B20MINER CLI installer\n%s\n' "$LINE" >> "$RC"
  echo "Added ~/.local/bin to PATH in $RC"
fi
echo ""
echo "Open a new terminal tab (or run: source $RC), then type:  b20miner"
