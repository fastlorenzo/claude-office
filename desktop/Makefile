# Desktop shell (Electron). See README.md.
.PHONY: install build dev test lint typecheck fmt checkall sidecars dist-linux dist-win clean

PKG_MGR := $(shell command -v bun >/dev/null 2>&1 && echo "bun" || echo "npm")

install:
	$(PKG_MGR) install
	# The Electron binary download is a postinstall step that some package
	# managers/wrappers skip; run it explicitly (no-op when present).
	node node_modules/electron/install.js

build:
	$(PKG_MGR) run build

sidecars:		# Frozen backend + hook for this OS (packaging/dist)
	$(MAKE) -C ../packaging all

dev: build		# Run the shell against packaging/dist + frontend/out
	@test -x ../packaging/dist/claude-office-server/claude-office-server || $(MAKE) sidecars
	@test -f ../frontend/out/index.html || (echo "frontend/out missing: make -C ../frontend build-static" && exit 1)
	npx electron .

test:
	$(PKG_MGR) test

lint:
	$(PKG_MGR) run lint

typecheck:
	$(PKG_MGR) run typecheck

fmt:
	@echo "desktop: no formatter configured"

checkall: lint typecheck test

dist-linux: build	# AppImage + .deb into release/
	npx electron-builder --linux --publish never

dist-win: build		# NSIS installer (on Windows; needs ../packaging/dist-linux from the Linux job)
	npx electron-builder --win --publish never

clean:
	rm -rf dist release
