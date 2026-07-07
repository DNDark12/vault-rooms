// esbuild's "binary" loader (configured in esbuild.config.mjs) turns a `.wasm` import into a
// base64 string embedded in the bundle, decoded into a Uint8Array at load time. tsc doesn't know
// about esbuild loaders, so declare the module shape here for type-checking.
declare module "*.wasm" {
  const content: Uint8Array;
  export default content;
}
