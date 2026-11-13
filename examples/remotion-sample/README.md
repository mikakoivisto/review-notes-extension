# Remotion sample (test fixture)

A minimal Remotion 4.0.543 project used by the Review Notes e2e tests and for trying the Remotion adapter by hand.
Versions are pinned on purpose: the adapter relies on undocumented Studio internals (see docs/SPEC.md §5.3).

```bash
npm install
npm run studio     # http://localhost:3123/Hello  (Playwright starts this itself)
```
