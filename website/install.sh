#!/bin/bash

# Voicci Installation Script
# Safe installation from voicci.com/voicci-cli

set -e  # Exit on error

echo ""
echo "🎧 Voicci - AI Audiobook Generator"
echo "=================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on supported OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     MACHINE=Linux;;
    Darwin*)    MACHINE=Mac;;
    *)          MACHINE="UNKNOWN:${OS}"
esac

if [ "$MACHINE" = "UNKNOWN:${OS}" ]; then
    echo -e "${RED}Error: Unsupported operating system: ${OS}${NC}"
    echo "Voicci currently supports macOS and Linux only."
    exit 1
fi

echo -e "${GREEN}✓${NC} Detected: $MACHINE"
echo ""

# Check git
if ! command -v git &> /dev/null; then
    echo -e "${RED}✗${NC} git not found"
    echo ""
    echo "Please install git:"
    echo "  macOS: brew install git"
    echo "  Linux: sudo apt-get install git"
    exit 1
fi

echo -e "${GREEN}✓${NC} git $(git --version | cut -d' ' -f3)"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗${NC} Node.js not found"
    echo ""
    echo "Please install Node.js 18.0.0 or higher:"
    echo "  macOS: brew install node"
    echo "  Linux: https://nodejs.org/en/download/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}✗${NC} Node.js version too old (found: $(node -v), required: 18+)"
    exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗${NC} npm not found"
    exit 1
fi

echo -e "${GREEN}✓${NC} npm $(npm -v)"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}✗${NC} Python 3 not found"
    echo ""
    echo "Please install Python 3.9 or higher:"
    echo "  macOS: brew install python@3.11"
    echo "  Linux: sudo apt-get install python3"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f1-2)
echo -e "${GREEN}✓${NC} Python $PYTHON_VERSION"

# Check pip
if ! command -v pip3 &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  pip3 not found (required for Python dependencies)"
    echo "  Installing pip3..."
    if [ "$MACHINE" = "Mac" ]; then
        curl https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
        python3 /tmp/get-pip.py
    fi
fi

echo ""
echo "────────────────────────────────────"
echo ""

# Legal disclaimer
echo -e "${YELLOW}⚠️  IMPORTANT LEGAL NOTICE${NC}"
echo ""
echo "By installing Voicci, you agree that:"
echo "  • You are responsible for compliance with copyright laws"
echo "  • You will only process content you have rights to use"
echo "  • Voicci provides Voicci 'as-is' with no warranties"
echo ""
echo "Do NOT use Voicci to infringe on copyrights."
echo ""
echo "────────────────────────────────────"
echo ""

read -p "Do you accept these terms? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 1
fi

echo ""
echo "Installing Voicci..."
echo ""

# Create temp directory
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Download from GitHub (or serve from voicci.com/voicci-cli/releases)
echo "Downloading Voicci..."
git clone --depth 1 https://github.com/voicci/voicci-cli.git
cd voicci

# Install Node dependencies
echo ""
echo "Installing Node.js dependencies..."
npm install

# Link globally
echo ""
echo "Installing globally..."
npm link

echo ""
echo -e "${GREEN}✓${NC} Voicci installed successfully!"
echo ""

# Prompt for Python dependencies
echo "────────────────────────────────────"
echo ""
echo "Voicci requires Python dependencies:"
echo "  • TTS (text-to-speech library)"
echo "  • PyTorch (AI framework)"
echo "  • torchaudio (audio processing)"
echo ""
echo "This will download ~2GB of data."
echo ""

read -p "Install Python dependencies now? (Y/n): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    echo ""
    echo "Installing Python dependencies (this may take a few minutes)..."
    pip3 install TTS torch torchaudio

    echo ""
    echo -e "${GREEN}✓${NC} Python dependencies installed"
else
    echo ""
    echo -e "${YELLOW}⚠${NC}  Skipped Python dependencies"
    echo "Install later with: pip3 install TTS torch torchaudio"
fi

# Check for poppler (optional)
echo ""
if ! command -v pdftotext &> /dev/null; then
    echo -e "${YELLOW}⚠${NC}  pdftotext not found (optional, for PDF support)"
    echo ""
    if [ "$MACHINE" = "Mac" ]; then
        echo "Install with: brew install poppler"
    else
        echo "Install with: sudo apt-get install poppler-utils"
    fi
else
    echo -e "${GREEN}✓${NC} pdftotext available (PDF support enabled)"
fi

# Cleanup
cd ~
rm -rf "$TEMP_DIR"

echo ""
echo "════════════════════════════════════"
echo ""
echo -e "${GREEN}🎉 Installation complete!${NC}"
echo ""
echo "Get started:"
echo "  voicci --help"
echo "  voicci mybook.pdf"
echo '  voicci "The Great Gatsby"'
echo ""
echo "Configure:"
echo "  voicci config show"
echo "  voicci config set-profile high"
echo ""
echo "Documentation:"
echo "  https://voicci.com/voicci-cli/docs"
echo ""
echo "════════════════════════════════════"
echo ""
