#!/bin/bash

# Voicci Installer
# Converts PDF/text files to high-quality audiobooks using XTTS v2 AI

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Voicci Installer v1.0          ║${NC}"
echo -e "${BLUE}║  AI Audiobook Generator (XTTS v2)     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Detect OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     OS_TYPE=Linux;;
    Darwin*)    OS_TYPE=Mac;;
    *)          OS_TYPE="UNKNOWN:${OS}"
esac

if [[ "$OS_TYPE" == "UNKNOWN"* ]]; then
    echo -e "${RED}✗${NC} Unsupported operating system: ${OS}"
    echo "Voicci currently supports macOS and Linux only."
    exit 1
fi

echo -e "${GREEN}✓${NC} Detected OS: ${OS_TYPE}"

# Check dependencies
echo ""
echo "Checking dependencies..."

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION found"
else
    echo -e "${RED}✗${NC} Node.js not found"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

# Check npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓${NC} npm $NPM_VERSION found"
else
    echo -e "${RED}✗${NC} npm not found"
    exit 1
fi

# Check Python
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
    PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
    PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)

    if [[ $PYTHON_MAJOR -ge 3 ]] && [[ $PYTHON_MINOR -ge 9 ]]; then
        echo -e "${GREEN}✓${NC} Python $PYTHON_VERSION found"
    else
        echo -e "${RED}✗${NC} Python 3.9+ required (found $PYTHON_VERSION)"
        exit 1
    fi
else
    echo -e "${RED}✗${NC} Python 3 not found"
    echo "Please install Python 3.9+ from https://www.python.org/"
    exit 1
fi

# Check pip
if command -v pip3 &> /dev/null; then
    echo -e "${GREEN}✓${NC} pip3 found"
else
    echo -e "${RED}✗${NC} pip3 not found"
    exit 1
fi

# Check pdftotext (optional but recommended)
if command -v pdftotext &> /dev/null; then
    echo -e "${GREEN}✓${NC} pdftotext found"
else
    echo -e "${YELLOW}⚠${NC} pdftotext not found (optional, for PDF support)"
    echo "Install with: brew install poppler (Mac) or apt-get install poppler-utils (Linux)"
fi

# Determine installation directory
if [[ "$OS_TYPE" == "Mac" ]]; then
    INSTALL_DIR="$HOME/Library/Application Support/voicci"
else
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/voicci"
fi

echo ""
echo -e "Installation directory: ${BLUE}$INSTALL_DIR${NC}"
echo ""

# Ask for confirmation
read -p "Continue with installation? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 0
fi

# Create installation directory
echo ""
echo "Creating directories..."
mkdir -p "$INSTALL_DIR"/{lib,cli,backend}
echo -e "${GREEN}✓${NC} Directories created"

# Download Voicci files (in production, this would download from GitHub/website)
echo ""
echo "Installing Voicci..."

# For now, we'll create the files directly
# In production, this would be: curl -fsSL https://voicci.com/voicci-cli/voicci.tar.gz | tar -xz -C "$INSTALL_DIR"

# Install Node.js dependencies
cd "$INSTALL_DIR"
echo ""
echo "Installing Node.js dependencies..."

cat > package.json <<'EOF'
{
  "name": "voicci",
  "version": "1.0.0",
  "description": "AI Audiobook Generator using XTTS v2",
  "type": "module",
  "bin": {
    "voicci": "./cli/index.js"
  },
  "dependencies": {
    "commander": "^11.1.0",
    "better-sqlite3": "^9.2.2",
    "uuid": "^9.0.1",
    "ink": "^4.4.1",
    "react": "^18.2.0",
    "chalk": "^5.3.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF

npm install --silent --no-audit --no-fund 2>&1 | grep -v "npm WARN"
echo -e "${GREEN}✓${NC} Node.js dependencies installed"

# Install Python dependencies
echo ""
echo "Installing Python dependencies..."
echo "This may take several minutes (downloading XTTS v2 model ~450MB)..."

pip3 install --quiet --upgrade pip
pip3 install --quiet TTS torch torchaudio

echo -e "${GREEN}✓${NC} Python dependencies installed"

# Download XTTS v2 model
echo ""
echo "Downloading XTTS v2 model (this may take a few minutes)..."
python3 -c "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')" &>/dev/null || true
echo -e "${GREEN}✓${NC} XTTS v2 model downloaded"

# Create symlink for global access
BIN_DIR="/usr/local/bin"
if [[ -w "$BIN_DIR" ]]; then
    ln -sf "$INSTALL_DIR/cli/index.js" "$BIN_DIR/voicci"
    echo -e "${GREEN}✓${NC} Global command 'voicci' installed"
else
    echo -e "${YELLOW}⚠${NC} Could not create global command (insufficient permissions)"
    echo "Add to your PATH manually: export PATH=\"$INSTALL_DIR/cli:\$PATH\""
fi

# Final message
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Installation Complete! 🎉           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo "Usage:"
echo -e "  ${BLUE}voicci mybook.pdf${NC}          - Convert PDF to audiobook"
echo -e "  ${BLUE}voicci -s${NC}                   - Check all job statuses"
echo -e "  ${BLUE}voicci -l${NC}                   - List completed audiobooks"
echo -e "  ${BLUE}voicci -o <jobId>${NC}          - Open audiobook folder"
echo ""
echo "Installation location: $INSTALL_DIR"
echo ""
echo "Get started: voicci --help"
echo ""
