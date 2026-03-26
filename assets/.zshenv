# Bin setup
export PATH="$HOME/.local/bin:$PATH"

# Nix setup
if [ -e /home/developer/.nix-profile/etc/profile.d/nix.sh ]; then . /home/developer/.nix-profile/etc/profile.d/nix.sh; fi # added by Nix installer

# Devbox setup
export DO_NOT_TRACK=1
eval "$(devbox global shellenv --preserve-path-stack -r)"
