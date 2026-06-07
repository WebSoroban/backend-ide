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

# Install Stellar CLI using cargo (official method)
RUN cargo install --locked stellar-cli

# Create symlink for backward compatibility (soroban -> stellar)
RUN ln -s /usr/local/cargo/bin/stellar /usr/local/cargo/bin/soroban

# Add cargo bin to PATH
ENV PATH="/usr/local/cargo/bin:$PATH"

# Create working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
# Prisma schema is required by the postinstall `prisma generate`
COPY prisma ./prisma

# Install Node dependencies (postinstall runs `prisma generate`)
RUN npm cache clean --force \
    && npm install --production --no-optional \
    && npm cache clean --force

# Copy application files
COPY . .

# Copy and make compile script executable
COPY scripts/compile.sh /usr/local/bin/compile.sh
RUN chmod +x /usr/local/bin/compile.sh

# Create necessary directories
RUN mkdir -p /app/temp /app/logs

# Expose port
EXPOSE 3001

# Start Node.js application
CMD ["npm", "start"]