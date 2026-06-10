# Bin setup
export PATH="$HOME/.local/bin:$PATH"

# Nix setup
if [ -e /home/developer/.nix-profile/etc/profile.d/nix.sh ]; then . /home/developer/.nix-profile/etc/profile.d/nix.sh; fi # added by Nix installer

# Devbox setup (installed by svc-bootstrap — guard so first-boot SSH logins
# that land before bootstrap finishes don't error on every prompt)
export DO_NOT_TRACK=1
if command -v devbox > /dev/null 2>&1; then
    eval "$(devbox global shellenv --preserve-path-stack -r)"
fi
