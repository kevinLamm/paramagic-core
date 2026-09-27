# Browser solver kernel

`solver.cpp` ports ParaMagic's existing LM iteration, analytical derivatives,
sparse Jacobian products and entity-block preconditioned conjugate gradient
solver. It uses double precision, one CPU thread and a persistent memory arena.
There are no JavaScript imports, WASI calls, threads, external solver libraries
or dependencies on a server. The emitted WASM currently occupies about 138 KiB.

## Build

From the application root:

```powershell
npm run build:solver
npm run dev
```

The verified binary and `solver.build.json` travel with the core package. Normal
`dev`, `build`, and `build:pages` verify source/flags/binary SHA-256 hashes and use
that binary. A compiler is required only when native source or flags change.
The browser receives ordinary static Worker/WASM assets; users install nothing.

This experiment uses the portable official [WASI SDK 27 compiler](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27),
targeting **wasm32-unknown-unknown**, without the WASI runtime. The SDK's static
libc archive supplies CPU trigonometric functions; the linker retains only used
math functions. The build verifies that the module has zero imports. This avoids
Emscripten's Python build dependency, as requested. Extract the SDK outside the
source package and set `WASI_SDK_PATH` to its directory (or `WASM_CXX` to a
WebAssembly-capable `clang++` executable):

```powershell
$env:WASI_SDK_PATH = 'C:\toolchains\wasi-sdk-27.0-x86_64-windows'
node scripts/build-solver-wasm.mjs --force
```

The Windows release archive SHA-256 used here was
`4a576c13125c91996d8cc3b70b7ea0612c2044598d2795c9be100d15f874adf6`.
No system PATH modification is needed. The build script also discovers the
experiment's local SDK under `tmp/wasm-toolchain/`. Compiler version, flags,
source hash and binary hash are recorded in the manifest. Fast math and floating
point contraction are disabled. CI can verify the checked-in artifact without
installing a compiler; rebuilding it requires the same compiler setup.

## Ownership and ABI

`WasmSolverSession.js` owns all packing and ABI validation. Each instance holds
one component world. `configure` reserves the coordinate, target, constraint,
CSR, preconditioner, and scratch arrays. Memory grows only during structural
configuration. Numeric edits retain row offsets, columns and capacity.

`begin` starts from the current coordinates. `advance` runs bounded native work
and retains both LM and PCG state; JavaScript never evaluates an individual
residual or drives a nonlinear iteration. Worker scheduling yields between
chunks so revision-control messages can cancel obsolete work. No timer remains
after convergence. A single sparse pass can exceed the scheduling target on
very large components; the scheduling target is not a hard real-time bound.

ABI 4 reserves packed instruction/data arrays and reusable differentiation
scratch. `WasmConstraintCompiler.js` lowers extended constraints once; C++ owns
every evaluation and derivative pass. `WasmFilletCompiler.js` lowers the existing
fillet construction and branch selection. The direct kernels remain in place.
Arc center dependencies and initial branch seeds use packed buffers as well.

`WasmSwellModel.js` packs Swell source references, definitions, joins and feature
selectors. `swell_geometry.h` owns offset geometry, transitions, joined endpoints,
cycle normals, curve samples and the resident geometry cache. Swell's reference
finite-difference derivatives also run natively; no JS geometry callback occurs
within an iteration. Buffers 20 and 21 hold structural and numeric Swell input.
Numerical definition and parameter edits preserve the CSR structure and arena.

`sparse_elimination.h` retains the reference bounded sparse LDLᵀ factorization
and refinement in resident numeric memory. The adapter uses the existing
`compileConstraintTopology` for arc and Stack-placement components, limited
to 2,048 active variables and 65,536 factor entries. Larger systems retain
native sparse PCG. All direct solves use the original `1e-7` numerical ridge.
The large-system sparse-direct experiment, its alternate topology compiler
and its constructor option have been removed. The native source and binary
match the snapshot saved before that experiment.

Stack placement uses persistent frame variables
and constant geometry views, with temporary gauges released after each solve.

Separate persistent instances expose the packed numeric expression, union-find
component graph, and continuation buffers in `parameter_kernel.h`,
`graph_kernel.h`, and `continuation.h`. Keeping these arenas separate prevents
component configuration from invalidating their memory. Numeric/Boolean
expression programs execute as a batch; parsing, symbols, units and reference
string/error behavior stay in JavaScript. Continuation coordinates, predictions
and checkpoints stay native; JavaScript controls the transaction and annotations.

`swell_export` supplies typed geometry arrays for display. The tool checks a
source/parameter fingerprint before using a packet; stale results use the
reference evaluator. Boundary assembly and actual SVG rendering stay JavaScript.

Graph metadata and scope, transactions, document rollback, gauges, annotations,
document state and rendering retain their existing JavaScript owners. All 25
registered constraint types now have native implementations, including arcs,
tangency, fillets, interpolation and global frames.
Unsupported components run entirely through the reference solver and report
the reason in `jacobianStats.fallbackReason`. There is no partial constraint
omission. Derived Swell points, segments, arcs, circles and sampled curves now
participate in native constraint evaluation. The `fallbackBlocks` counter on a
native result counts native numerical derivatives, not JavaScript solving.

The numerical result includes status, residual norm squared, iterations,
allocated arena bytes, topology builds and memory growth count. `linearize` is
an oracle-test API for residual and Jacobian comparisons. See the application's
`docs/WASM_SOLVER_IMPLEMENTATION.md` for measurements and remaining limits.
