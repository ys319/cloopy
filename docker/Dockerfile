FROM ubuntu:24.04

LABEL org.opencontainers.image.title="cloopy" \
      org.opencontainers.image.description="Battery-included Docker sandbox for Claude Code" \
      org.opencontainers.image.source="https://github.com/ys319/cloopy" \
      org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# s6-overlay version + release tarball checksums. Pinned so a tampered or
# swapped release asset fails the build instead of becoming PID 1. When
# bumping the version, update all three from the release's *.sha256 files:
# https://github.com/just-containers/s6-overlay/releases
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG S6_OVERLAY_NOARCH_SHA256=6dbcde158a3e78b9bb141d7bcb5ccb421e563523babbe2c64470e76f4fd02dae
ARG S6_OVERLAY_AARCH64_SHA256=8b22a2eaca4bf0b27a43d36e65c89d2701738f628d1abd0cea5569619f66f785
ARG S6_OVERLAY_X86_64_SHA256=59289456ab1761e277bd456a95e737c06b03ede99158beb24f12b165a904f478

# ==============================================================================
# 1. System Dependencies
# ==============================================================================
# - openssh-server: SSH access
# - git, curl, wget: Basics
# - xz-utils: Required for Nix and s6-overlay
# - locales, tzdata: Localization
# - iptables: egress firewall (init-firewall, provides ip6tables too)
# ==============================================================================
RUN : Install dependencies \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        openssh-server \
        curl \
        wget \
        git \
        xz-utils \
        locales \
        tzdata \
        ca-certificates \
        zsh \
        iproute2 \
        iptables \
    && rm -rf /var/lib/apt/lists/*

# grml zshrc (vendored to avoid network dependency at build time)
# Update: docker/vendor/update-grml-zshrc.sh
COPY vendor/grml-zshrc /etc/zsh/zshrc

# Generate locales
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# ==============================================================================
# 2. s6-overlay Installation
# ==============================================================================
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
RUN echo "${S6_OVERLAY_NOARCH_SHA256}  /tmp/s6-overlay-noarch.tar.xz" | sha256sum -c - \
    && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && rm /tmp/s6-overlay-noarch.tar.xz

# Architecture-specific binary (auto-detect from TARGETARCH)
# Only amd64/arm64 are supported: any other TARGETARCH falls through to
# x86_64, whose tarball passes the sha256 check but cannot execute as PID 1.
ARG TARGETARCH
RUN S6_ARCH=$(case "${TARGETARCH}" in arm64) echo "aarch64";; *) echo "x86_64";; esac) \
    && S6_SHA256=$(case "${TARGETARCH}" in arm64) echo "${S6_OVERLAY_AARCH64_SHA256}";; *) echo "${S6_OVERLAY_X86_64_SHA256}";; esac) \
    && wget -q -O /tmp/s6-overlay-arch.tar.xz \
       "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
    && echo "${S6_SHA256}  /tmp/s6-overlay-arch.tar.xz" | sha256sum -c - \
    && tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz \
    && rm /tmp/s6-overlay-arch.tar.xz

# s6-overlay behaviour
ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=600000

# ==============================================================================
# 3. System Configuration
# ==============================================================================
RUN mkdir -p /var/run/sshd

# ==============================================================================
# 4. Default User (developer)
# ==============================================================================
# Remove default ubuntu user if it exists to avoid UID/GID conflict
RUN : \
    && touch /var/mail/ubuntu \
    && chown ubuntu /var/mail/ubuntu \
    && userdel -r ubuntu \
    || true

RUN : \
    && groupadd --gid 1000 developer \
    && useradd --uid 1000 --gid 1000 -m -s /bin/zsh developer

# ==============================================================================
# 5. s6-overlay Files
# ==============================================================================
COPY s6-overlay/ /etc/s6-overlay/

RUN find /etc/s6-overlay/scripts -type f -exec chmod +x {} + \
    && find /etc/s6-overlay/s6-rc.d -type f \( -name up -o -name run \) -exec chmod +x {} +

EXPOSE 22

# s6-overlay as PID 1
ENTRYPOINT ["/init"]
