# ParaMagic Core

`@paramagic/core` is the reusable ParaMagic parametric drawing editor and document engine.

The package exposes the interactive editor, document codec and merge behavior, solver,
geometry systems, and exporters through separate browser-compatible ES module entry points.
Host applications provide their own product shell and persistence UI.

Install the tagged public package directly from GitHub:

```sh
npm install github:kevinLamm/paramagic-core#v0.1.0
```

Public entry points:

- `@paramagic/core/editor` — interactive canvas, tools, and editor systems.
- `@paramagic/core/document` — `.paramagic` parsing, serialization, normalization, and merge behavior.
- `@paramagic/core/solver` — parametric solver and worker APIs.
- `@paramagic/core/geometry` — geometry, topology, and derived-feature operations.
- `@paramagic/core/images` — image fills, catalogs, portable image assets, and host resource configuration.
- `@paramagic/core/export` — DXF and SVG output.

### Browser solver selection

The application's normal Worker mode now selects the native WASM solver by default.
No URL flag is needed. `?solverBackend=javascript` selects the reference backend;
`?solverBackend=wasm` remains supported. A valid `PARAMAGIC_SOLVER_BACKEND` host
override takes precedence over the URL. Standalone synchronous controllers remain
JavaScript, and the app retains JavaScript for local transactions, verification and
fallback when native initialization or component preparation is unavailable.

Keep the reference solver when distributing the core. The native binary and its
verified build manifest are included in the normal application build workflow;
end users install nothing. Selecting WASM does not change document formats,
final convergence tolerances, or the single-threaded browser CPU execution model.

For a frontend-only host, keep the built-in image files and manifest in the app and configure
their public URLs before creating the editor:

```js
import {
  configureImageCatalogResources,
  configureOpenCvResources,
} from '@paramagic/core/images';

configureImageCatalogResources({
  manifestUrl: new URL('./assets/catalog.json', import.meta.url),
  assetBaseUrl: new URL('./assets/images/', import.meta.url),
});

configureOpenCvResources({
  scriptUrl: new URL('./vendor/opencv.js', import.meta.url),
});
```

Manifest entries use stable logical references such as `basic/Fabric/linen.webp`. The host can
move its deployed asset directory without changing references stored in ParaMagic documents.
OpenCV.js is supplied by the pinned `@techstark/opencv-js` dependency; the host controls the
public URL used to load that script.

### Trace Region execution

Trace Region uses the pinned OpenCV WASM operations in a separate, persistent module
Worker. `ImageTraceClient` transfers decoded RGBA pixels once when tracing an image;
later requests contain only a seed and settings. `ImageTraceKernel` retains native
Mats and completed stages, including connected-component labels and contours. Edge
Detail changes therefore rerun only polygon approximation. Superseded requests stop
between native stages. The Worker does no further work after producing a result.

Closing Trace Region releases image Mats while retaining the initialized OpenCV
module for reuse. WASM heap capacity can remain at its high-water mark. Initial
image decoding and canvas readback still occur on the main thread. This path uses
single-threaded WASM and ordinary transferable buffers; it requires no shared
memory, COOP/COEP headers, or end-user installation. The configured OpenCV script
must be loadable from a module Worker. Vite emits the Worker and OpenCV assets in
the normal application builds.

`ImageTrace.js` retains the original tracing implementation for numerical comparison.
Apply Trace uses the same atomic line-chain creation path as the Polyline tool,
including Auto Constraint and the normal final solver tolerance. With Auto Constraint
enabled, relationships are inferred from the whole original outline before solving;
this can differ from the former per-segment path, which repeatedly inferred against
already-adjusted segments. A rejected batch preserves the trace preview for retry.
