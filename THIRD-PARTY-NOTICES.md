# Third-party notices

`@execuro-sw-ecosystem/sw-tender-discovery-tool` has **zero runtime
dependencies**. One third-party file is vendored into the published package.
Nothing else is bundled, and nothing is fetched by the browser at runtime —
the xlsx reader and writer (`lib/xlsx.mjs`, `lib/xlsx-patch.mjs`) are original
code with no vendored parser.

## Vendored

### marked

`page/vendor/marked.min.js` — marked v15.0.12, MIT License,
Copyright (c) 2011-2025 Christopher Jeffrey.
<https://github.com/markedjs/marked>

Vendored unchanged from
`https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.12/marked.min.js`.
The full licence text is in `page/vendor/LICENSE-marked.txt`.
