# TradingView Charting Library (vendored)

Source: the private `charting_library` repository at `git.abjs.cc`, snapshot
`CL v31.2.0`. Copied here rather than installed as a dependency because the
library ships no module entry point a bundler can resolve, and keeping it under
`public/` lets the browser load it as a classic script exactly as it expects.

## Licence

The Charting Library is proprietary TradingView software. It is redistributed
here under the terms accepted when it was downloaded from TradingView; it is
**not** covered by this repository's Apache-2.0 licence. Keep this directory
intact when copying it, and do not assume the Apache-2.0 `LICENSE` at the
repository root applies to these files.

## Updating

Replace the whole directory with a newer snapshot; do not mix files from two
versions. After replacing, verify the loader still works -- the bundle exposes
`window.TradingView` and a rename there breaks every chart in the app:

    grep -c "TradingView" charting_library.standalone.js
