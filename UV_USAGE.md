# Running AN3S with uv

[uv](https://github.com/astral-sh/uv) is a fast Python package manager written in Rust. Here's how to use it with this project.

## Install uv

If you don't have uv installed:

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or with Homebrew
brew install uv

# Or with pip
pip install uv
```

## Quick Start

### 1. Create a virtual environment and install dependencies

```bash
# Create a virtual environment (if not exists)
uv venv

# Activate the virtual environment
source .venv/bin/activate  # macOS/Linux
# or on Windows: .venv\Scripts\activate

# Install all dependencies
uv pip install -e .
```

### 2. Run the development server

```bash
# Option 1: Using python -m (as documented in README)
python -m app

# Option 2: Direct execution with environment variables
PORT=8080 DATA_DIR="$(pwd)/data" python -m app

# Option 3: Use uv run (runs in isolated environment)
uv run python -m app
```

## Development Workflow

### Install with development dependencies

```bash
# Install the project with dev tools (pytest, black, etc.)
uv pip install -e ".[dev]"
```

### Sync dependencies (faster alternative to pip install)

```bash
# Sync exact dependencies from pyproject.toml
uv pip sync

# Or compile and sync from requirements.txt
uv pip compile pyproject.toml -o requirements-lock.txt
uv pip sync requirements-lock.txt
```

### Run commands with uv

```bash
# Run the app directly with uv (no activation needed)
uv run python -m app

# Run with environment variables
uv run --env PORT=8081 --env DATA_DIR=./data python -m app

# Run tests (if you add pytest)
uv run pytest

# Run code formatters
uv run black app/
uv run isort app/
```

## Common uv Commands

```bash
# Install a new package and add to pyproject.toml
uv pip install requests

# Install specific version
uv pip install "flask>=3.0.3"

# List installed packages
uv pip list

# Show package info
uv pip show flask

# Uninstall package
uv pip uninstall package-name

# Upgrade package
uv pip install --upgrade package-name

# Upgrade all packages
uv pip install --upgrade -e ".[dev]"
```

## Why use uv?

- **Speed**: 10-100x faster than pip
- **Reliability**: Better dependency resolution
- **Modern**: Works great with pyproject.toml
- **No separate pip**: uv handles everything

## Production Deployment

For production (Docker), the existing workflow remains the same since the Dockerfile uses standard pip. However, you can modify the Dockerfile to use uv for faster builds:

```dockerfile
# Add to Dockerfile (optional optimization)
RUN pip install uv
RUN uv pip install --no-cache-dir -r requirements.txt
```

## Troubleshooting

### Port already in use
The app automatically finds an available port (8080, 8081, 5000, 5001). Or set explicitly:
```bash
PORT=9000 uv run python -m app
```

### Data directory permissions
```bash
# Ensure data directory exists and is writable
mkdir -p data
export DATA_DIR="$(pwd)/data"
uv run python -m app
```

### Virtual environment issues
```bash
# Remove and recreate
rm -rf .venv
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
```
