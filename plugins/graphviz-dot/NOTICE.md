# Notices for `graphviz-dot.wasm`

The binary `graphviz-dot.wasm` is built from the sources in this directory
together with the third-party code listed here. **The binary as a whole is
governed by the Eclipse Public License 2.0** (see `LICENSE-EPL-2.0.txt`),
because it contains Graphviz. The files written for this plugin
(`src/`, `Makefile`, `config.h`, `fetch-toolchain.sh`, `plugin.json`,
`examples/`) are MIT licensed like the rest of this repository.

## Graphviz 16.1.0 (EPL-2.0)

- Copyright (c) AT&T Intellectual Property and the Graphviz contributors. Licensed under the
  Eclipse Public License v2.0, <https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.html>.
  The license text is in `LICENSE-EPL-2.0.txt`. Project: <https://graphviz.org>.
- **Source code.** The binary contains Graphviz *unmodified*. The exact source release is
  `graphviz-16.1.0.tar.xz`, available at
  <https://gitlab.com/api/v4/projects/4207231/packages/generic/graphviz-releases/16.1.0/graphviz-16.1.0.tar.xz>
  (SHA-256 `0f661718f3e5268dc3bad0fb53ab646605d26db70f4080799aff1dc2f61783c3`).
  `fetch-toolchain.sh` downloads and verifies it, and `make` builds the binary from it with the
  files in this directory, so anyone can rebuild `graphviz-dot.wasm` from source.
- Parts used: `cdt`, `cgraph`, `common`, `gvc`, `dotgen`, `pack`, `label`, `xdot`, `util`,
  `pathplan`, `ortho`, `sparse`, `rbtree`, the `dot_layout` plugin and the SVG renderer of the
  `core` plugin. The generated parsers (`grammar.c`, `htmlparse.c`) come from GNU Bison, whose
  skeleton license has an exception that allows distributing them under other terms.

## ColorBrewer color tables (Apache-style license)

Graphviz's color name table includes the ColorBrewer schemes.

```
Apache-Style Software License for ColorBrewer software and ColorBrewer 
Color Schemes, Version 1.1

Copyright (c) 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania 
State University. All rights reserved.

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:
  1. Redistributions as source code must retain the above copyright notice, 
this list of conditions and the following disclaimer.
  2. The end-user documentation included with the redistribution, if any, 
must include the following acknowledgment:
     This product includes color specifications and designs developed 
     by Cynthia Brewer (http://colorbrewer.org/).
Alternately, this acknowledgment may appear in the software itself, if and 
wherever such third-party acknowledgments normally appear.
  4. The name "ColorBrewer" must not be used to endorse or promote products 
derived from this software without prior written permission. For written 
permission, please contact Cynthia Brewer at cbrewer@psu.edu.
  5. Products derived from this software may not be called "ColorBrewer", nor 
may "ColorBrewer" appear in their name, without prior written permission 
of Cynthia Brewer.

THIS SOFTWARE IS PROVIDED "AS IS" AND ANY EXPRESSED OR IMPLIED WARRANTIES, 
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND 
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL CYNTHIA 
BREWER, MARK HARROWER, OR THE PENNSYLVANIA STATE UNIVERSITY BE LIABLE FOR 
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Red-black tree by Emin Martinian (BSD-style license; part of Graphviz, `lib/rbtree`)

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that neither the name of Emin
Martinian nor the names of any contributors are be used to endorse or
promote products derived from this software without specific prior
written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## wasi-libc and compiler runtime (from wasi-sdk 34.0)

The module is statically linked with wasi-libc and the LLVM compiler runtime, taken unmodified
from wasi-sdk 34.0 (<https://github.com/WebAssembly/wasi-sdk>).

- wasi-libc is licensed `Apache-2.0 WITH LLVM-exception`, `Apache-2.0` and `MIT`. It includes
  code derived from musl libc (MIT) and dlmalloc (public domain, CC0). See
  <https://github.com/WebAssembly/wasi-libc> for the license files.
- The compiler runtime is `Apache-2.0 WITH LLVM-exception`.

We found no GPL- or LGPL-licensed code among the sources that go into the binary.
