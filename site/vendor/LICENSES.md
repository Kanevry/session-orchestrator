# Vendored library licences

Everything in this directory is self-hosted so the site makes **zero external
requests**. That is both a performance property and a privacy property, and the
privacy policy at `/datenschutz` asserts it. Do not replace any of these with a CDN
link without changing that page too.

| File | Component | Licence | Source |
|---|---|---|---|
| `three.module.min.js` | three.js (ES module entry) | MIT | `npm three@0.185.1 build/three.module.min.js` |
| `three.core.min.js` | three.js (core chunk) | MIT | `npm three@0.185.1 build/three.core.min.js` |

Both files are required and must stay side by side: `three.module.min.js` contains
`from"./three.core.min.js"`, a relative import the browser resolves against this
directory. Copying only the module file yields a 404 and a dead hero.

No addons, no loaders, no workers are vendored. `site/assets/hero.js` is the only
importer. Verified 2026-09-07 with
`grep -c "eval(\|new Function(\|new Worker(\|importScripts" site/vendor/*.min.js`:
0 matches in both files, which is what lets the site keep a CSP without
`unsafe-eval` and without blob workers.

## MIT License (three.js)

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
