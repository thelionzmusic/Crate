#!/bin/sh
# Builds each instrument's WebAssembly module for the browser engine. Needs clang and wasm-ld
# (LLVM 15 or later). Run from anywhere; the modules land in web/js/produce/instruments/.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../crate/web/js/produce/instruments"
mkdir -p "$out"
clang++ --target=wasm32 -std=c++17 -O3 -ffreestanding -nostdlib -fno-exceptions -fno-rtti \
  -mbulk-memory -mnontrapping-fptoint -Wall -Wextra \
  -Wl,--no-entry -Wl,--export=__wasm_call_ctors -Wl,--strip-all \
  "$here/wasm.cpp" -o "$out/fm.wasm"
ls -l "$out"/*.wasm
