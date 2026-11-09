// A minimal WebSocket server for one local client: Crate's own page.
// Listens on 127.0.0.1 only and refuses any page whose Origin isn't Crate's, so other websites
// open in a browser can't drive the engine.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace crate {

class WsServer {
 public:
  WsServer();
  ~WsServer();
  // binds 127.0.0.1:port (0 = any free port); returns the port, or 0 on failure
  int listen(int port, std::vector<std::string> origins);
  // waits up to `ms` for activity; calls onText for each complete text message
  void poll(int ms, const std::function<void(const std::string&)>& onText, const std::function<void()>& onConnect);
  bool connected() const { return client_ >= 0; }
  void sendText(const std::string& s) { send(0x1, s.data(), s.size()); }
  void sendBinary(const void* p, size_t n) { send(0x2, p, n); }

 private:
  void send(uint8_t op, const void* p, size_t n);
  bool handshake();
  void drop();
  bool readFrames(const std::function<void(const std::string&)>& onText);
  long long listen_ = -1, client_ = -1;
  bool open_ = false;
  std::vector<std::string> origins_;
  std::string in_, msg_;
};

std::string sha1Base64(const std::string& s);

}  // namespace crate
