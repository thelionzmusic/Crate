// The engine's replies to the page are small JSON lines; these build them safely.
#pragma once
#include <cstdio>
#include <string>

namespace crate {

inline std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += c;
  }
  return o;
}

inline std::string err(const std::string& what, const std::string& msg) {
  return "{\"type\":\"error\",\"what\":\"" + esc(what) + "\",\"message\":\"" + esc(msg) + "\"}";
}

}  // namespace crate
