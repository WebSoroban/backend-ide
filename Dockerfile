FROM rust:1.89-slim

# Install system dependencies including Node.js
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    pkg-config \
    libssl-dev \
    libdbus-1-dev \
    libudev-dev \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install wasm32v1 target for Rust 1.85+
RUN rustup target add wasm32v1-none

# Install the Stellar CLI from the official PREBUILT release binary instead of
# `cargo install` — building stellar-cli/stellar-xdr from source needs 6-8GB+
# RAM and OOM-kills (SIGKILL) on memory-constrained build hosts. Falls back to a
# single-job cargo build only if no prebuilt artifact exists for the platform.
ARG STELLAR_CLI_VERSION=25.2.0
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)        target="x86_64-unknown-linux-gnu" ;; \
      aarch64|arm64) target="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch: $arch"; exit 1 ;; \
    esac; \
    url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${target}.tar.gz"; \
    echo "Downloading prebuilt Stellar CLI: $url"; \
    if curl -fsSL "$url" -o /tmp/stellar-cli.tar.gz; then \
      tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin; \
      rm -f /tmp/stellar-cli.tar.gz; \
      chmod +x /usr/local/bin/stellar; \
    else \
      echo "Prebuilt download failed; falling back to single-job cargo build"; \
      CARGO_BUILD_JOBS=1 cargo install --locked stellar-cli@${STELLAR_CLI_VERSION}; \
      cp /usr/local/cargo/bin/stellar /usr/local/bin/stellar; \
    fi; \
    stellar --version

# Create symlink for backward compatibility (soroban -> stellar)
RUN ln -s /usr/local/bin/stellar /usr/local/bin/soroban

# Add cargo bin to PATH
ENV PATH="/usr/local/cargo/bin:$PATH"

# Create working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
# Prisma schema is required by the postinstall `prisma generate`
COPY prisma ./prisma

# Install Node dependencies, including devDependencies (typescript) needed to
# build the project. postinstall runs `prisma generate`.
RUN npm cache clean --force \
    && npm install --no-optional \
    && npm cache clean --force

# Copy application files
COPY . .

# Compile TypeScript -> dist/ (build script = `prisma generate && tsc`)
RUN npm run build

# Copy and make compile script executable
COPY scripts/compile.sh /usr/local/bin/compile.sh
RUN chmod +x /usr/local/bin/compile.sh

# Create necessary directories
RUN mkdir -p /app/temp /app/logs

# Expose port
EXPOSE 3001

# Start Node.js application
CMD ["npm", "start"]