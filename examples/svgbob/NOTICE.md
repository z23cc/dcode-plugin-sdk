# Dependency notices

The plugin glue is MIT (see the LICENSE at the root of this repository). svgbob 0.7.6 is Apache-2.0.

This directory contains source only. The following is Cargo's locked dependency inventory (`Cargo.lock`), including build-only crates and crates that are not part of the final binary on `wasm32-wasip1`; it is broader than what is compiled in. **If you distribute a built `.wasm`**, include the license and notice files of the crates that went into it (the crates' repositories and the `.crate` files carry them; tools such as `cargo-about` generate the list from `Cargo.lock`), and the text of the Apache-2.0 license for svgbob.

| Package | Version | Declared license |
| --- | --- | --- |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 |
| approx | 0.5.1 | Apache-2.0 |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bstr | 1.13.1 | MIT OR Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| derive-where | 1.7.0 | MIT OR Apache-2.0 |
| doc-comment | 0.3.4 | MIT |
| downcast-rs | 1.2.1 | MIT/Apache-2.0 |
| either | 1.19.0 | MIT OR Apache-2.0 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| foldhash | 0.2.0 | Zlib |
| futures | 0.3.30 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| itertools | 0.11.0 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| js-sys | 0.3.106 | MIT OR Apache-2.0 |
| libm | 0.2.16 | MIT |
| log | 0.4.34 | MIT OR Apache-2.0 |
| longest-increasing-subsequence | 0.1.0 | MIT/Apache-2.0 |
| matrixmultiply | 0.3.11 | MIT/Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| nalgebra | 0.32.6 | BSD-3-Clause |
| nalgebra-macros | 0.2.2 | Apache-2.0 |
| num-complex | 0.4.6 | MIT OR Apache-2.0 |
| num-derive | 0.4.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| parry2d | 0.13.8 | Apache-2.0 |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| phf | 0.11.3 | MIT |
| phf_generator | 0.11.3 | MIT |
| phf_macros | 0.11.3 | MIT |
| phf_shared | 0.11.3 | MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| pom | 3.4.0 | MIT |
| proc-macro-error | 1.0.4 | MIT OR Apache-2.0 |
| proc-macro-error-attr | 1.0.4 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| proc-macro2-diagnostics | 0.10.1 | MIT/Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| rand | 0.8.8 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| rawpointer | 0.2.1 | MIT/Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| robust | 1.2.0 | MIT OR Apache-2.0 |
| rstml | 0.11.2 | MIT |
| rustc-hash | 1.1.0 | Apache-2.0/MIT |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| safe_arch | 0.7.4 | Zlib OR Apache-2.0 OR MIT |
| sauron | 0.61.9 | MIT |
| sauron-core | 0.61.9 | MIT |
| sauron-macro | 0.61.9 | MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde-wasm-bindgen | 0.5.0 | MIT |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| simba | 0.8.1 | Apache-2.0 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| smallvec | 1.16.3 | MIT OR Apache-2.0 |
| spade | 2.15.1 | MIT OR Apache-2.0 |
| svgbob | 0.7.6 | Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.9 | MIT OR Apache-2.0 |
| syn_derive | 0.1.8 | MIT OR Apache-2.0 |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| tokio | 1.54.1 | MIT |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-width | 0.1.14 | MIT OR Apache-2.0 |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-futures | 0.4.79 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 |
| web-sys | 0.3.106 | MIT OR Apache-2.0 |
| wide | 0.7.33 | Zlib OR Apache-2.0 OR MIT |
| yansi | 1.0.1 | MIT OR Apache-2.0 |
| zmij | 1.0.23 | MIT |
