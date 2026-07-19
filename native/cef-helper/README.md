# CEF helper

This helper is the offscreen browser process. It runs CEF offscreen
rendering and streams frames to the Bun host over TCP.

The TypeScript side expects this protocol:

1. helper writes one TCP port line to stdout;
2. Bun connects to localhost and sends the nonce plus `\n`;
3. helper sends length-prefixed JSON `frameFile` messages;
4. raw RGBA/RGB pixels are written into file-backed slots.

Build with:

```sh
CEF_ROOT=/path/to/cef_binary_... ./scripts/build-cef-helper.sh
```

Run with:

```sh
bun run src/main.ts https://example.com
```

This is intentionally an OSR baseline. It does not try to solve CEF bundle
packaging for every platform; wire that into `build-cef-helper.sh` for your
target OS.
