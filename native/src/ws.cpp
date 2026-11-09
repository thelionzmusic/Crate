#include "ws.hpp"

#include <algorithm>
#include <cstring>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
static void closeSock(long long s) { closesocket(static_cast<SOCKET>(s)); }
#define MSG_NOSIGNAL 0
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
static void closeSock(long long s) { ::close(static_cast<int>(s)); }
#endif

namespace crate {

// ---------- SHA-1 and base64, just for the handshake
std::string sha1Base64(const std::string& msg) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  std::string m = msg;
  const uint64_t bits = static_cast<uint64_t>(msg.size()) * 8;
  m += static_cast<char>(0x80);
  while (m.size() % 64 != 56) m += '\0';
  for (int i = 7; i >= 0; i--) m += static_cast<char>((bits >> (i * 8)) & 0xff);
  auto rol = [](uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };
  for (size_t off = 0; off < m.size(); off += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++)
      w[i] = (static_cast<uint32_t>(static_cast<uint8_t>(m[off + 4 * i])) << 24) | (static_cast<uint32_t>(static_cast<uint8_t>(m[off + 4 * i + 1])) << 16) |
             (static_cast<uint32_t>(static_cast<uint8_t>(m[off + 4 * i + 2])) << 8) | static_cast<uint8_t>(m[off + 4 * i + 3]);
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const uint32_t t = rol(a, 5) + f + e + k + w[i];
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  unsigned char dig[20];
  for (int i = 0; i < 5; i++) for (int j = 0; j < 4; j++) dig[i * 4 + j] = static_cast<unsigned char>(h[i] >> (24 - 8 * j));
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (int i = 0; i < 20; i += 3) {
    const uint32_t v = (dig[i] << 16) | ((i + 1 < 20 ? dig[i + 1] : 0) << 8) | (i + 2 < 20 ? dig[i + 2] : 0);
    out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63];
    out += i + 1 < 20 ? T[(v >> 6) & 63] : '='; out += i + 2 < 20 ? T[v & 63] : '=';
  }
  return out;
}

WsServer::WsServer() {
#ifdef _WIN32
  WSADATA d; WSAStartup(MAKEWORD(2, 2), &d);
#endif
}
WsServer::~WsServer() {
  drop();
  if (listen_ >= 0) closeSock(listen_);
#ifdef _WIN32
  WSACleanup();
#endif
}

int WsServer::listen(int port, std::vector<std::string> origins) {
  origins_ = std::move(origins);
  sock_t s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  sockaddr_in a{};
  a.sin_family = AF_INET; a.sin_port = htons(static_cast<uint16_t>(port)); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (::bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(s, 4) != 0) { closeSock(static_cast<long long>(s)); return 0; }
  socklen_t len = sizeof a;
  getsockname(s, reinterpret_cast<sockaddr*>(&a), &len);
  listen_ = static_cast<long long>(s);
  return ntohs(a.sin_port);
}

void WsServer::drop() {
  if (client_ >= 0) closeSock(client_);
  client_ = -1; open_ = false; in_.clear(); msg_.clear();
}

void WsServer::poll(int ms, const std::function<void(const std::string&)>& onText, const std::function<void()>& onConnect) {
  fd_set fds; FD_ZERO(&fds);
  FD_SET(static_cast<sock_t>(listen_), &fds);
  long long top = listen_;
  if (client_ >= 0) { FD_SET(static_cast<sock_t>(client_), &fds); top = std::max(top, client_); }
  timeval tv{0, ms * 1000};
  if (::select(static_cast<int>(top + 1), &fds, nullptr, nullptr, &tv) <= 0) return;
  if (FD_ISSET(static_cast<sock_t>(listen_), &fds)) {
    const sock_t c = ::accept(static_cast<sock_t>(listen_), nullptr, nullptr);
    if (c != static_cast<sock_t>(-1)) {
      drop();  // a reloaded page replaces the old connection
      client_ = static_cast<long long>(c);
      int one = 1; setsockopt(c, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof one);
    }
    return;
  }
  if (client_ >= 0 && FD_ISSET(static_cast<sock_t>(client_), &fds)) {
    char buf[65536];
    const int n = static_cast<int>(::recv(static_cast<sock_t>(client_), buf, sizeof buf, 0));
    if (n <= 0) { drop(); return; }
    in_.append(buf, n);
    if (!open_) {
      if (in_.find("\r\n\r\n") == std::string::npos) { if (in_.size() > 16384) drop(); return; }
      if (!handshake()) { drop(); return; }
      onConnect();
    }
    if (!readFrames(onText)) drop();
  }
}

bool WsServer::handshake() {
  const size_t end = in_.find("\r\n\r\n");
  std::string head = in_.substr(0, end);
  in_.erase(0, end + 4);
  auto header = [&](const std::string& name) {
    std::string low = head; std::transform(low.begin(), low.end(), low.begin(), ::tolower);
    const size_t p = low.find("\r\n" + name + ":");
    if (p == std::string::npos) return std::string();
    size_t a = p + name.size() + 3; const size_t b = head.find("\r\n", a);
    while (a < b && head[a] == ' ') a++;
    return head.substr(a, b - a);
  };
  const std::string key = header("sec-websocket-key"), origin = header("origin");
  if (key.empty()) return false;
  if (!origins_.empty() && std::find(origins_.begin(), origins_.end(), origin) == origins_.end()) {
    const std::string no = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
    ::send(static_cast<sock_t>(client_), no.data(), static_cast<int>(no.size()), 0);
    return false;
  }
  const std::string res = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
                          sha1Base64(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11") + "\r\n\r\n";
  ::send(static_cast<sock_t>(client_), res.data(), static_cast<int>(res.size()), 0);
  open_ = true;
  return true;
}

// parse whole frames out of in_; false means the connection should close
bool WsServer::readFrames(const std::function<void(const std::string&)>& onText) {
  for (;;) {
    if (in_.size() < 2) return true;
    const auto* b = reinterpret_cast<const uint8_t*>(in_.data());
    const bool fin = b[0] & 0x80, masked = b[1] & 0x80;
    const uint8_t op = b[0] & 0x0f;
    uint64_t len = b[1] & 0x7f;
    size_t at = 2;
    if (len == 126) { if (in_.size() < 4) return true; len = (b[2] << 8) | b[3]; at = 4; }
    else if (len == 127) { if (in_.size() < 10) return true; len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | b[2 + i]; at = 10; }
    if (!masked || len > (16u << 20)) return false;  // clients must mask; nothing we take is this big
    if (in_.size() < at + 4 + len) return true;
    const uint8_t* mask = b + at;
    std::string payload(len, '\0');
    for (uint64_t i = 0; i < len; i++) payload[i] = static_cast<char>(b[at + 4 + i] ^ mask[i & 3]);
    in_.erase(0, at + 4 + len);
    if (op == 0x8) return false;                                   // close
    if (op == 0x9) { send(0xA, payload.data(), payload.size()); continue; }  // ping
    if (op == 0x1 || op == 0x0) {
      msg_ += payload;
      if (fin) { onText(msg_); msg_.clear(); }
    }
  }
}

void WsServer::send(uint8_t op, const void* p, size_t n) {
  if (!open_) return;
  std::string f;
  f += static_cast<char>(0x80 | op);
  if (n < 126) f += static_cast<char>(n);
  else if (n < 65536) { f += static_cast<char>(126); f += static_cast<char>(n >> 8); f += static_cast<char>(n & 0xff); }
  else { f += static_cast<char>(127); for (int i = 7; i >= 0; i--) f += static_cast<char>((static_cast<uint64_t>(n) >> (8 * i)) & 0xff); }
  f.append(static_cast<const char*>(p), n);
  size_t sent = 0;
  while (sent < f.size()) {
    const int k = static_cast<int>(::send(static_cast<sock_t>(client_), f.data() + sent, static_cast<int>(f.size() - sent), MSG_NOSIGNAL));
    if (k <= 0) { drop(); return; }
    sent += static_cast<size_t>(k);
  }
}

}  // namespace crate
