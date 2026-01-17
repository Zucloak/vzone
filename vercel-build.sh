#!/bin/bash
set -e

echo "Starting Vercel Build Script..."

# 1. Install Rust if missing
if ! command -v cargo &> /dev/null; then
    echo "Cargo not found. Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
else
    echo "Rust/Cargo is already installed."
fi

# Ensure cargo is in PATH
export PATH="$HOME/.cargo/bin:$PATH"

# Verify Rust installation
echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"

# 2. Build Wasm
echo "Building Wasm..."
# Ensure wasm-pack is installed
npm install -D wasm-pack

cd recorder_core
npx wasm-pack build --target web
cd ..

# 3. Build Frontend
echo "Building Frontend..."
tsc -b
vite build

echo "Build Completed Successfully."
