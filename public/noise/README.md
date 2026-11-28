# Vendored noise suppression

These files are served as static assets and loaded into an AudioWorklet by `app/noise-suppression.ts`.

| File | Source | License |
| --- | --- | --- |
| `rnnoise-worklet.js`, `rnnoise.wasm`, `rnnoise_simd.wasm` | [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) 0.4.2, wrapping [@shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm) and [xiph/rnnoise](https://github.com/xiph/rnnoise) | MIT, Apache-2.0, BSD-3-Clause |
| `gtcrn-worklet.js`, `gtcrn.wasm` | [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) 0.4.2, wrapping [sapphi-red/gtcrn-wasm](https://github.com/sapphi-red/gtcrn-wasm), [Xiaobin-Rong/gtcrn](https://github.com/Xiaobin-Rong/gtcrn) and pffft | MIT, BSD-style (pffft) |
| `voice-gate-worklet.js` | Written for RaRRcord | Same as this repository |

The worklet files are the package's `dist/*/workletProcessor.js` with only the source map comment removed. Each keeps its upstream license banner.

To update, run `npm pack @sapphi-red/web-noise-suppressor@<version>` and copy the same files from `package/dist/`.
