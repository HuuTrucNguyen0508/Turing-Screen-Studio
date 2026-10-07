# Contributing

Start with [README.md](README.md), [the first milestone](docs/first-milestone.md) and [AGENTS.md](AGENTS.md). The useful public starting point is the offline browser editor. You can develop and test it without a screen or the private dashboard installation.

## Set up

Use Node.js 22.12 or newer and pnpm 11.28.3. Keep `pnpm-lock.yaml` and the root `packageManager` declaration in sync. Use pnpm for all JavaScript package commands.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

For the optional Linux API and Python tests, use Python 3.10 or newer:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

The launcher prefers the root `.venv`; `TURZX_PYTHON` selects an explicit interpreter. `pnpm studio` builds and serves the editor with its loopback API on port 5174.

## Make a change

Keep the versioned layout contract and editing operations independent of React. Save integer coordinates and sizes. Browser scaling must preserve exact document geometry. Use deterministic preview samples and retain palette values in JSON round trips.

For canvas changes, test both fitting cards and keeping positions, invalid dimensions, bounds and Undo. Custom canvas sizes support design, export and preview. The existing active panel layout and saved dashboard library remain limited to 1280 × 800. See [screen sizes](docs/screen-sizes.md).

Follow the existing Caelestia palette roles and make text readable at the card's saved size. Check affected controls at narrow browser widths. Preserve unrelated working changes.

Keep hardware integration separate from editor work. Read the live runtime and [panel integration](docs/panel-integration.md) before proposing transport changes. Preserve the documented 270° rotation and exclusive USB ownership. Do not run `panel:install`, `panel:rollback` or `shortcuts:install` as routine development checks. They change services or desktop configuration on the existing machine.

## Verify

Run the checks relevant to your change. Domain tests compare JavaScript and Python layout behavior, so `pnpm test` also needs `python3` on your PATH with Pillow installed from `requirements.txt`. The editor itself and its build do not need Python:

```bash
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
PYTHONPATH=runtime .venv/bin/python -m unittest discover -s runtime/tests
```

On Linux, Playwright's `install --with-deps chromium` can install required browser libraries. Its tests run against the production build and manage a loopback server on port 4175. CI uses Ubuntu, Node.js 24 and separate editor, browser and Python jobs. It installs Pillow from `requirements.txt` and needs no dashboard, driver or USB device. Tests that explicitly require external panel fonts may skip when those fonts are absent.

For manual checks, use [the offline acceptance steps](docs/first-milestone.md#manual-verification). Confirm export and reopen preserve the document, invalid imports keep the draft intact, and browser resizing changes only the view.

## Send a pull request

Explain the problem, the resulting behavior and what you checked. Include a screenshot for visible UI changes and a small example for layout-format changes. Report checks you could not run. Keep unrelated cleanup separate.

For bugs, include the operating system, Node.js and pnpm versions, reproduction steps and a minimal exported layout if it helps. Remove local paths, usage logs and other personal data before sharing examples.

Preserve bundled font license files. The external USB driver has a separate GPL-3.0 license and is not vendored here. See [third-party notices](THIRD_PARTY_NOTICES.md) before adding assets or driver code.
