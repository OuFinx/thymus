#!/bin/bash
# Shell startup files: one item per existing file, hashed.
items=""
for p in "$HOME"/.zshenv "$HOME"/.zprofile "$HOME"/.zshrc "$HOME"/.zlogin "$HOME"/.zlogout \
         "$HOME"/.bashrc "$HOME"/.bash_profile "$HOME"/.bash_login "$HOME"/.profile \
         "$HOME"/.config/fish/config.fish "$HOME"/.config/fish/conf.d/*.fish \
         /etc/zshenv /etc/zprofile /etc/zshrc /etc/zlogin /etc/profile /etc/bashrc; do
  [ -f "$p" ] || continue
  hash=$(shasum -a 256 < "$p" | cut -c1-64)
  id=${p/#$HOME/\~}
  items="$items${items:+,}{\"id\":\"$id\",\"label\":\"$id\",\"path\":\"$p\",\"hash\":\"$hash\"}"
done
echo "[$items]"
