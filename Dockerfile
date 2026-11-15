# Claude Office Visualizer - Multi-stage Dockerfile
# Stage 1: Build frontend with Node.js
# Stage 2: Fetch the gh CLI (CI/CD panel)
# Stage 3: Run backend with Python/uv

# =============================================================================
# Stage 1: Frontend Build
# =============================================================================
FROM oven/bun:1-slim AS frontend-builder

# bun run assets shells out to unzip (ambientCG material zips) and tar xjf
# (KTX-Software .tar.bz2); the slim image ships neither unzip nor bzip2.
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip bzip2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/frontend

# Copy package files first for better layer caching
COPY frontend/package.json frontend/bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy frontend source
COPY frontend/ ./

# Download CC0 3D assets (Poly Haven, ambientCG) and Havok wasm
RUN bun run assets

# Build static export
RUN bun run build

# =============================================================================
# Stage 2: gh CLI (upstream release; Debian's 2.46 lacks `run list --json attempt`)
# =============================================================================
FROM debian:trixie-slim AS gh-cli

ARG TARGETARCH
ARG GH_VERSION=2.103.3
ADD https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz /tmp/
ADD https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt /tmp/
RUN cd /tmp \
    && grep " gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz$" gh_${GH_VERSION}_checksums.txt | sha256sum -c - \
    && tar -xzf gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz \
    && install -m 0755 gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh /usr/local/bin/gh

# =============================================================================
# Stage 3: Python Runtime
# =============================================================================
FROM python:3.13-slim AS runtime

# Install uv for fast Python package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# gh CLI feeds the factory view's CI/CD panel (backend/app/core/ci_poller.py).
# Authenticate it at runtime with GH_TOKEN (a read-only token is enough).
COPY --from=gh-cli /usr/local/bin/gh /usr/local/bin/gh

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1

WORKDIR /app

# Copy backend dependency files
COPY backend/pyproject.toml backend/uv.lock* backend/README.md* ./

# Install dependencies (without dev dependencies)
RUN uv sync --no-dev --frozen

# Copy backend source
COPY backend/app ./app

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/out ./static

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the application
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
