FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# s6-overlay version
ARG S6_OVERLAY_VERSION=3.2.0.2

# ==============================================================================
# 1. System Dependencies
# ==============================================================================
# - openssh-server: SSH access
# - git, curl, wget: Basics
# - xz-utils: Required for Nix and s6-overlay
# - locales, tzdata: Localization
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
    && rm -rf /var/lib/apt/lists/* \
    && wget -O /etc/zsh/zshrc https://git.grml.org/f/grml-etc-core/etc/zsh/zshrc

# Generate locales
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# ==============================================================================
# 2. s6-overlay Installation
# ==============================================================================
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && rm /tmp/s6-overlay-noarch.tar.xz

# Architecture-specific binary (auto-detect from TARGETARCH)
ARG TARGETARCH
RUN S6_ARCH=$(case "${TARGETARCH}" in arm64) echo "aarch64";; *) echo "x86_64";; esac) \
    && wget -q -O /tmp/s6-overlay-arch.tar.xz \
       "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
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
