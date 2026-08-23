# ParaMagic Core

`@paramagic/core` is the reusable ParaMagic parametric drawing editor and document engine.

The package exposes the interactive editor, document codec and merge behavior, solver,
geometry systems, and exporters through separate browser-compatible ES module entry points.
Host applications provide their own product shell and persistence UI.

Public entry points:

- `@paramagic/core/editor` — interactive canvas, tools, and editor systems.
- `@paramagic/core/document` — `.paramagic` parsing, serialization, normalization, and merge behavior.
- `@paramagic/core/solver` — parametric solver and worker APIs.
- `@paramagic/core/geometry` — geometry, topology, and derived-feature operations.
- `@paramagic/core/images` — image fills, catalogs, portable image assets, and host resource configuration.
- `@paramagic/core/export` — DXF and SVG output.

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
