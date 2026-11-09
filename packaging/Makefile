# Frozen sidecar binaries for the desktop app (see docs: desktop packaging plan).
# Each component builds in an isolated venv under build/ (never the component's
# dev .venv) holding only its runtime deps + PyInstaller. Output: dist/<name>/
.PHONY: all server hook smoke clean

PYI := --with pyinstaller pyinstaller --noconfirm --distpath $(CURDIR)/dist --workpath $(CURDIR)/build

all: server hook

server:
	cd ../backend && UV_PROJECT_ENVIRONMENT=$(CURDIR)/build/venv-server uv run --no-dev --frozen $(PYI) $(CURDIR)/server.spec

hook:
	cd ../hooks && UV_PROJECT_ENVIRONMENT=$(CURDIR)/build/venv-hook uv run --no-dev --frozen $(PYI) $(CURDIR)/hook.spec

smoke:			# Frozen server + hook end-to-end check (needs `make all` first)
	uv run --no-project python smoke.py

clean:
	rm -rf dist build
