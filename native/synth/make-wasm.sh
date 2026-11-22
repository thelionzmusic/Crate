#!/bin/sh
# Builds each instrument's WebAssembly module for the browser engine. Needs clang and wasm-ld
# (LLVM 15 or later). Run from anywhere; the modules land in web/js/produce/instruments/.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../crate/web/js/produce/instruments"
mkdir -p "$out"
build() {  # <module name> <header> <class> [more flags]
  clang++ --target=wasm32 -std=c++17 -O3 -ffreestanding -nostdlib -fno-exceptions -fno-rtti \
    -mbulk-memory -mnontrapping-fptoint -Wall -Wextra \
    -Wl,--no-entry -Wl,--export=__wasm_call_ctors -Wl,--strip-all \
    "-DSYNTH_HEADER=\"$2\"" "-DSYNTH=$3" $4 "$here/wasm.cpp" -o "$out/$1.wasm"
}
build fm fm.hpp synth::Fm
build add additive.hpp synth::Additive
build grain granular.hpp synth::Granular -DSYNTH_SAMPLES
ls -l "$out"/*.wasm
