#!/bin/bash
# Unify Claude and Codex skills in ~/AGENTSKILLS, keeping both tools' skills
# directories as real folders that reference the shared skills via symlinks.
# Safe to rerun any time you add a new skill (it re-links everything).
set -e

mkdir -p ~/AGENTSKILLS ~/.codex/skills ~/.claude/skills

# 1. Move any real (non-symlink) skill folders from both tools into ~/AGENTSKILLS
for dir in ~/.codex/skills ~/.claude/skills; do
  for d in "$dir"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    [ -L "$d" ] && continue          # already a symlink, skip
    name=$(basename "$d")
    if [ ! -e ~/AGENTSKILLS/"$name" ]; then
      mv "$d" ~/AGENTSKILLS/
    else
      mv "$d" "$d.bak"               # name clash: keep as backup, shared copy wins
    fi
  done
done

# 2. Link every shared skill into both tools' skills folders
for d in ~/AGENTSKILLS/*/; do
  name=$(basename "${d%/}")
  ln -sfn ~/AGENTSKILLS/"$name" ~/.codex/skills/"$name"
  ln -sfn ~/AGENTSKILLS/"$name" ~/.claude/skills/"$name"
done

echo "=== Shared skills in ~/AGENTSKILLS ==="
ls ~/AGENTSKILLS
echo "--- ~/.codex/skills ---"
ls -l ~/.codex/skills
echo "--- ~/.claude/skills ---"
ls -l ~/.claude/skills
echo "=== DONE ==="
