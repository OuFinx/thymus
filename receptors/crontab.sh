#!/bin/bash
# One item per active line of the user crontab.
items=$(crontab -l 2>/dev/null | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' | while IFS= read -r line; do
  hash=$(printf '%s' "$line" | shasum -a 256 | cut -c1-64)
  label=$(printf '%s' "$line" | tr '\t' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"id":"%s","label":"%s","hash":"%s"}\n' "${hash:0:12}" "$label" "$hash"
done | paste -sd, -)
echo "[$items]"
