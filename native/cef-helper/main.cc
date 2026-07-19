#include "include/cef_app.h"
#include "include/cef_accessibility_handler.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_display_handler.h"
#include "include/cef_frame.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_parser.h"
#include "include/cef_render_handler.h"
#include "include/cef_request_handler.h"
#include "include/cef_task.h"
#include "include/cef_values.h"
#include "include/cef_v8.h"
#include "include/wrapper/cef_message_router.h"
#include "include/wrapper/cef_helpers.h"
#include "kitty_cef_core.h"
#include "include/wrapper/cef_library_loader.h"

#include <algorithm>
#include <cctype>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#error "This starter helper intentionally implements the POSIX transport path only. Port FrameServer/RawSlots to Win32 before building on Windows."
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <limits.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace {

int clampInt(int n, int lo, int hi) { return std::max(lo, std::min(hi, n)); }
double clampNumber(double n, double lo, double hi) { return std::max(lo, std::min(hi, n)); }

bool envBool(const char* name, bool fallback) {
  const char* value = std::getenv(name);
  if (!value || !*value) return fallback;
  std::string lower(value);
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return !(lower == "0" || lower == "false" || lower == "no" || lower == "off");
}

struct PaintDirtyRect {
  bool valid = false;
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

template <typename RectListT>
PaintDirtyRect mergePaintDirtyRects(const RectListT& dirty_rects, int frame_width, int frame_height) {
  if (dirty_rects.empty() || frame_width <= 0 || frame_height <= 0) return {};

  int left = frame_width;
  int top = frame_height;
  int right = 0;
  int bottom = 0;

  for (const auto& rect : dirty_rects) {
    const int x1 = clampInt(rect.x, 0, frame_width);
    const int y1 = clampInt(rect.y, 0, frame_height);
    const int x2 = clampInt(rect.x + rect.width, 0, frame_width);
    const int y2 = clampInt(rect.y + rect.height, 0, frame_height);
    if (x2 <= x1 || y2 <= y1) continue;

    left = std::min(left, x1);
    top = std::min(top, y1);
    right = std::max(right, x2);
    bottom = std::max(bottom, y2);
  }

  if (right <= left || bottom <= top) return {};

  PaintDirtyRect out;
  out.valid = true;
  out.x = static_cast<uint32_t>(left);
  out.y = static_cast<uint32_t>(top);
  out.width = static_cast<uint32_t>(right - left);
  out.height = static_cast<uint32_t>(bottom - top);
  return out;
}

int argInt(int argc, char** argv, int index, int fallback) {
  if (index >= argc || !argv[index] || !*argv[index]) return fallback;
  char* end = nullptr;
  long v = std::strtol(argv[index], &end, 10);
  if (!end || *end != '\0') return fallback;
  return static_cast<int>(v);
}

double argDouble(int argc, char** argv, int index, double fallback) {
  if (index >= argc || !argv[index] || !*argv[index]) return fallback;
  char* end = nullptr;
  double v = std::strtod(argv[index], &end);
  if (!end || *end != '\0') return fallback;
  return v;
}

std::string selfExecutablePath() {
#if defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::vector<char> buf(size + 1);
  if (_NSGetExecutablePath(buf.data(), &size) == 0) {
    char resolved[PATH_MAX];
    if (realpath(buf.data(), resolved)) return resolved;
    return std::string(buf.data());
  }
  return "";
#elif defined(__linux__)
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n > 0) {
    buf[n] = '\0';
    return std::string(buf);
  }
  return "";
#else
  return "";
#endif
}

bool fileExists(const std::string& path) {
  struct stat st {};
  return !path.empty() && ::stat(path.c_str(), &st) == 0;
}

std::string parentDir(std::string path) {
  while (path.size() > 1 && path.back() == '/') path.pop_back();
  const size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) return ".";
  if (slash == 0) return "/";
  return path.substr(0, slash);
}

std::string resolveBrowserSubprocessPath() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_SUBPROCESS_PATH");
  if (env && *env) return env;

  const std::string self = selfExecutablePath();
  if (self.empty()) return "";

#if defined(__APPLE__)
  // Browser process:
  //   kitty-cef-helper.app/Contents/MacOS/kitty-cef-helper
  //
  // Renderer / utility / network subprocess should be launched from:
  //   kitty-cef-helper.app/Contents/Frameworks/
  //     kitty-cef-helper Helper.app/Contents/MacOS/kitty-cef-helper Helper
  //
  // Do not point browser_subprocess_path back to the main app executable on
  // macOS. It can initialize, but renderer subprocess startup can fail or
  // silently never produce OSR OnPaint.
  const std::string macos_dir = parentDir(self);
  const std::string contents_dir = parentDir(macos_dir);
  const std::string helper =
    contents_dir +
    "/Frameworks/kitty-cef-helper Helper.app/Contents/MacOS/kitty-cef-helper Helper";

  if (fileExists(helper)) return helper;
#endif

  return self;
}

bool envEnabled(const char* name) {
  const char* value = std::getenv(name);
  if (!value || !*value) return false;
  return std::string(value) != "0" &&
         std::string(value) != "false" &&
         std::string(value) != "FALSE" &&
         std::string(value) != "no" &&
         std::string(value) != "NO";
}

bool noDiskMode() {
  return envEnabled("KITTY_WEB_UI_NO_DISK") ||
         envEnabled("KITTY_WEB_UI_CEF_NO_DISK");
}

std::string argString(int argc, char** argv, int index, const std::string& fallback = "") {
  if (index >= argc || !argv[index]) return fallback;
  return argv[index];
}

std::string defaultDesktopUserAgent() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
         "AppleWebKit/537.36 (KHTML, like Gecko) "
         "Chrome/120.0.0.0 Safari/537.36";
}

std::string defaultRawDirBase() {
  const char* env = std::getenv("KITTY_WEBVIEW_RAW_DIR");
  if (env && *env) return env;
  if (::access("/dev/shm", W_OK | X_OK) == 0) return "/dev/shm";
  const char* tmp = std::getenv("TMPDIR");
  return tmp && *tmp ? tmp : "/tmp";
}

bool mkdirOne(const std::string& path) {
  if (path.empty()) return false;
  if (::mkdir(path.c_str(), 0700) == 0) return true;
  return errno == EEXIST;
}

bool mkdirAll(std::string path) {
  if (path.empty()) return false;
  while (path.size() > 1 && path.back() == '/') path.pop_back();

  size_t start = path[0] == '/' ? 1 : 0;
  for (size_t i = start; i < path.size(); ++i) {
    if (path[i] != '/') continue;
    if (!mkdirOne(path.substr(0, i))) return false;
  }

  return mkdirOne(path);
}

std::string defaultCacheBase() {
  const char* xdg = std::getenv("XDG_CACHE_HOME");
  if (xdg && *xdg && xdg[0] == '/') return xdg;

  const char* home = std::getenv("HOME");
  if (home && *home) return std::string(home) + "/.cache";

  const char* tmp = std::getenv("TMPDIR");
 return tmp && *tmp ? tmp : "/tmp";
}

std::string persistentCefRootCachePath() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_ROOT_CACHE");
  if (env && *env) return env;
  return defaultCacheBase() + "/kitty-web-ui/cef";
}

std::string ephemeralCefRootCachePath() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_ROOT_CACHE");
  if (env && *env) return env;

  const char* tmp = std::getenv("TMPDIR");
  std::string base = tmp && *tmp ? tmp : "/tmp";
  std::string tmpl = base + "/kitty-web-ui-cef-cache-" + std::to_string(getpid()) + "-XXXXXX";

  std::vector<char> buf(tmpl.begin(), tmpl.end());
  buf.push_back('\0');

  char* made = ::mkdtemp(buf.data());
  if (made && *made) return made;

  std::string fallback = base + "/kitty-web-ui-cef-cache-" + std::to_string(getpid());
  mkdirAll(fallback);
  return fallback;
}

std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (unsigned char c : in) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

std::string jsonQuote(const std::string& in) {
  return "\"" + jsonEscape(in) + "\"";
}

std::string jsonFromCefValue(CefRefPtr<CefValue> value) {
  return value ? CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString() : "null";
}

std::string cefCursorShape(cef_cursor_type_t type) {
  switch (type) {
    case CT_IBEAM:
      return "text";
    case CT_HAND:
      return "pointer";
    case CT_CROSS:
      return "crosshair";
    case CT_GRAB:
      return "grab";
    case CT_GRABBING:
      return "grabbing";
    case CT_NONE:
      return "none";
    default:
      return "default";
  }
}

bool allowFileUrls() {
  return envEnabled("KITTY_WEB_UI_ALLOW_FILE_URL");
}

bool startsWithAllowedScheme(const std::string& url, bool allowHttp) {
  if (url == "about:blank") return true;
  if (url.rfind("https://", 0) == 0) return true;
  if (allowHttp && url.rfind("http://", 0) == 0) return true;
  if (allowFileUrls() && url.rfind("file://", 0) == 0) return true;
  return false;
}

std::string jsonString(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return "";
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return "";
  p = json.find('"', p + 1);
  if (p == std::string::npos) return "";
  std::string out;
  for (size_t i = p + 1; i < json.size(); ++i) {
    char c = json[i];
    if (c == '"') return out;
    if (c == '\\' && i + 1 < json.size()) {
      char n = json[++i];
      switch (n) {
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        default: out.push_back(n); break;
      }
    } else {
      out.push_back(c);
    }
  }
  return out;
}

double jsonNumber(const std::string& json, const std::string& key, double fallback = 0) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return fallback;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return fallback;
  size_t b = json.find_first_of("-0123456789.", p + 1);
  if (b == std::string::npos) return fallback;
  size_t e = b;
  while (e < json.size() && std::string("-0123456789.eE+").find(json[e]) != std::string::npos) e++;
  try { return std::stod(json.substr(b, e - b)); } catch (...) { return fallback; }
}

bool jsonBool(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return false;
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return false;
  size_t b = json.find_first_not_of(" \t\r\n", p + 1);
  return b != std::string::npos && json.compare(b, 4, "true") == 0;
}

std::vector<uint8_t> convertBgra(const void* srcVoid, int width, int height, bool rgb) {
  const uint8_t* src = static_cast<const uint8_t*>(srcVoid);
  const size_t pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
  std::vector<uint8_t> out(pixels * (rgb ? 3 : 4));
  if (rgb) {
    for (size_t i = 0, j = 0; i < pixels; ++i) {
      out[j++] = src[i * 4 + 2];
      out[j++] = src[i * 4 + 1];
      out[j++] = src[i * 4 + 0];
    }
  } else {
    for (size_t i = 0, j = 0; i < pixels; ++i) {
      out[j++] = src[i * 4 + 2];
      out[j++] = src[i * 4 + 1];
      out[j++] = src[i * 4 + 0];
      out[j++] = src[i * 4 + 3];
    }
  }
  return out;
}

bool writeAll(int fd, const void* data, size_t len) {
  const char* p = static_cast<const char*>(data);
  while (len > 0) {
    ssize_t n = ::write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (n == 0) return false;
    p += n;
    len -= static_cast<size_t>(n);
  }
  return true;
}

class FrameServer {
 public:
  bool Start(const std::string& nonce) {
    nonce_ = nonce;
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) return false;

    int yes = 1;
    setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) return false;
    if (::listen(listen_fd_, 1) < 0) return false;

    socklen_t len = sizeof(addr);
    if (::getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len) < 0) return false;
    std::printf("%d\n", ntohs(addr.sin_port));
    std::fflush(stdout);

    accept_thread_ = std::thread([this] { AcceptOnce(); });
    return true;
  }

  void Stop() {
    int old_listen = listen_fd_.exchange(-1);
    if (old_listen >= 0) ::close(old_listen);
    int old_client = client_fd_.exchange(-1);
    if (old_client >= 0) ::close(old_client);
    if (accept_thread_.joinable()) accept_thread_.join();
  }

  bool Connected() const { return client_fd_.load() >= 0; }

  bool SendHeader(std::string header) {
    int fd = client_fd_.load();
    if (fd < 0) return false;
    while ((header.size() & 3) != 0) header.push_back(' ');
    uint32_t len = static_cast<uint32_t>(header.size());
    uint8_t prefix[4] = {
      static_cast<uint8_t>(len & 0xff),
      static_cast<uint8_t>((len >> 8) & 0xff),
      static_cast<uint8_t>((len >> 16) & 0xff),
      static_cast<uint8_t>((len >> 24) & 0xff),
    };
    std::lock_guard<std::mutex> lock(write_mu_);
    return writeAll(fd, prefix, sizeof(prefix)) && writeAll(fd, header.data(), header.size());
  }

  bool SendFrame(std::string header, const void* data, size_t data_len) {
    int fd = client_fd_.load();
    if (fd < 0) return false;
    while ((header.size() & 3) != 0) header.push_back(' ');
    uint32_t header_len = static_cast<uint32_t>(header.size());
    uint8_t header_prefix[4] = {
      static_cast<uint8_t>(header_len & 0xff),
      static_cast<uint8_t>((header_len >> 8) & 0xff),
      static_cast<uint8_t>((header_len >> 16) & 0xff),
      static_cast<uint8_t>((header_len >> 24) & 0xff),
    };
    uint32_t body_len = static_cast<uint32_t>(data_len);
    uint8_t body_prefix[4] = {
      static_cast<uint8_t>(body_len & 0xff),
      static_cast<uint8_t>((body_len >> 8) & 0xff),
      static_cast<uint8_t>((body_len >> 16) & 0xff),
      static_cast<uint8_t>((body_len >> 24) & 0xff),
    };
    std::lock_guard<std::mutex> lock(write_mu_);
    return writeAll(fd, header_prefix, sizeof(header_prefix)) &&
           writeAll(fd, header.data(), header.size()) &&
           writeAll(fd, body_prefix, sizeof(body_prefix)) &&
           writeAll(fd, data, data_len);
  }

 private:
  void AcceptOnce() {
    int lfd = listen_fd_.load();
    if (lfd < 0) return;
    int cfd = ::accept(lfd, nullptr, nullptr);
    if (cfd < 0) return;

    std::string line;
    char ch = 0;
    while (::read(cfd, &ch, 1) == 1) {
      if (ch == '\n') break;
      line.push_back(ch);
      if (line.size() > 4096) break;
    }

    if (line != nonce_) {
      std::fprintf(stderr, "[cef] frame auth failed\n");
      ::close(cfd);
      return;
    }

    int old_listen = listen_fd_.exchange(-1);
    if (old_listen >= 0) ::close(old_listen);
    client_fd_.store(cfd);
    std::fprintf(stderr, "[cef] frame client connected\n");
  }

  std::string nonce_;
  std::atomic<int> listen_fd_{-1};
  std::atomic<int> client_fd_{-1};
  std::thread accept_thread_;
  std::mutex write_mu_;
};

class RawSlots {
 public:
  RawSlots() {
    int slots = 2;
    if (const char* env = std::getenv("KITTY_WEBVIEW_RAW_SLOTS")) slots = clampInt(std::atoi(env), 2, 16);
    const std::string base = defaultRawDirBase();
    std::string tmpl = base + "/kitty-webview-cef-" + std::to_string(getpid()) + "-XXXXXX";
    std::vector<char> buf(tmpl.begin(), tmpl.end());
    buf.push_back('\0');
    char* made = ::mkdtemp(buf.data());
    dir_ = made ? made : base;

    for (int i = 0; i < slots; ++i) {
      std::string p = dir_ + "/" + std::to_string(i) + ".rgba";
      int fd = ::open(p.c_str(), O_CREAT | O_RDWR | O_TRUNC, 0600);
      if (fd >= 0) {
        paths_.push_back(p);
        fds_.push_back(fd);
      }
    }
  }

  ~RawSlots() { Cleanup(); }

  std::string Write(const std::vector<uint8_t>& data) {
    if (fds_.empty()) return "";
    if (slot_size_ != data.size()) {
      slot_size_ = data.size();
      for (int fd : fds_) ::ftruncate(fd, static_cast<off_t>(slot_size_));
      next_ = 0;
    }
    size_t slot = next_++ % fds_.size();
    if (::pwrite(fds_[slot], data.data(), data.size(), 0) < 0) return "";
    return paths_[slot];
  }

  void Cleanup() {
    for (int fd : fds_) if (fd >= 0) ::close(fd);
    for (const auto& p : paths_) ::unlink(p.c_str());
    if (!dir_.empty()) ::rmdir(dir_.c_str());
    fds_.clear();
    paths_.clear();
  }

 private:
  std::string dir_;
  std::vector<std::string> paths_;
  std::vector<int> fds_;
  size_t next_ = 0;
  size_t slot_size_ = 0;
};

struct RuntimeState {
  std::atomic<int> view_w{1280};
  std::atomic<int> view_h{800};
  std::atomic<int> generation{0};
  std::atomic<int> seq{0};
  int fps = 60;
  double zoom_factor = 1.0;
  double dpr = 1.0;
  bool allow_http = false;
  bool debug = false;
  bool rgb = false;
  KittyCore* core = nullptr;

  // Layer 1: DevTools Protocol.
  std::atomic<int> devtools_id{1};

  // Frame flow-control. Bun acks only after Kitty's complete command has been
  // written/drained. While a frame is in flight, remember skipped paints so the
  // next accepted paint diffs the whole viewport against the delivered base.
  std::atomic<uint64_t> sent_frame_seq{0};
  std::atomic<uint64_t> acked_frame_seq{0};
  std::atomic<uint64_t> flow_dropped_frames{0};
  std::atomic<bool> missed_paint{false};
  std::atomic<bool> staging_seed_needed{true};

  std::string initial_url;
  std::string site_profile;
  FrameServer server;

  // Layer 2: browser-process side of CEF MessageRouter.
  // Renderer-side router is owned by KittyCefApp because renderer subprocesses
  // re-enter this same executable.
  CefRefPtr<CefMessageRouterBrowserSide> message_router;
};

RuntimeState* g_state = nullptr;
CefRefPtr<CefBrowser> g_browser;
std::atomic<bool> g_devtools_initialized{false};
std::atomic<bool> g_first_paint_seen{false};
std::atomic<bool> g_browser_create_requested{false};
std::atomic<bool> g_browser_created{false};

void ForcePaint() {
  if (!g_browser) return;
  g_browser->GetHost()->WasResized();
  g_browser->GetHost()->Invalidate(PET_VIEW);
}

class ForcePaintUntilFirstFrameTask : public CefTask {
 public:
  explicit ForcePaintUntilFirstFrameTask(int remaining) : remaining_(remaining) {}

  void Execute() override {
    CEF_REQUIRE_UI_THREAD();
    if (!g_browser || g_first_paint_seen.load() || remaining_ <= 0) return;

    ForcePaint();
    CefPostDelayedTask(TID_UI, new ForcePaintUntilFirstFrameTask(remaining_ - 1), 100);
  }

 private:
  int remaining_;
  IMPLEMENT_REFCOUNTING(ForcePaintUntilFirstFrameTask);
};

void LoadInitialUrlAfterFirstBlankPaint() {
  if (!g_browser || !g_state) return;
  if (!startsWithAllowedScheme(g_state->initial_url, g_state->allow_http)) return;
  g_browser->GetMainFrame()->LoadURL(g_state->initial_url);
}

class LoadInitialUrlTask : public CefTask {
 public:
  void Execute() override {
    CEF_REQUIRE_UI_THREAD();
    LoadInitialUrlAfterFirstBlankPaint();
  }

 private:
  IMPLEMENT_REFCOUNTING(LoadInitialUrlTask);
};

void SendMetadataJson(const std::string& json) {
  if (!g_state) return;
  g_state->server.SendHeader(json);
}

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::steady_clock::now().time_since_epoch()
  ).count();
}

bool enableDevToolsLayer() {
  return envEnabled("KITTY_WEB_UI_CEF_DEVTOOLS_LAYER");
}

bool enableFrameAck() {
  return envBool("KITTY_WEB_UI_CEF_FRAME_ACK", true);
}

bool enableFrameFlowControl() {
  return envBool("KITTY_WEB_UI_CEF_FLOW_CONTROL", true);
}

uint64_t maxUnackedFrames() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_MAX_UNACKED_FRAMES");
  if (!env || !*env) return 1;
  int value = std::atoi(env);
  return static_cast<uint64_t>(clampInt(value, 1, 16));
}

bool shouldDropPaintForFlowControl() {
  if (!enableFrameFlowControl()) return false;
  if (!g_state) return false;
  const uint64_t sent = g_state->sent_frame_seq.load(std::memory_order_relaxed);
  const uint64_t acked = g_state->acked_frame_seq.load(std::memory_order_relaxed);
  if (sent <= acked) return false;
  return sent - acked >= maxUnackedFrames();
}

bool enableDevToolsMetricsOverride() {
  return envEnabled("KITTY_WEB_UI_CEF_DEVTOOLS_METRICS");
}

bool enableMessageRouterLayer() {
  return envEnabled("KITTY_WEB_UI_CEF_MESSAGE_ROUTER");
}

bool enableAccessibilityLayer() {
  return envEnabled("KITTY_WEB_UI_CEF_ACCESSIBILITY");
}

bool enableAccessibilityVerbose() {
  return envEnabled("KITTY_WEB_UI_CEF_ACCESSIBILITY_VERBOSE");
}

int accessibilityThrottleMs() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_ACCESSIBILITY_THROTTLE_MS");
  if (!env || !*env) return 1000;
  return clampInt(std::atoi(env), 100, 10000);
}

void SendDevToolsEvent(const std::string& kind, const std::string& payload_json) {
  SendMetadataJson(
    "{\"type\":\"devtools\",\"kind\":\"" +
    jsonEscape(kind) +
    "\",\"payload\":" +
    (payload_json.empty() ? "null" : payload_json) +
    "}"
  );
}

bool SendDevToolsRaw(const std::string& json) {
  if (!enableDevToolsLayer()) return false;
  if (!g_browser) return false;
  return g_browser->GetHost()->SendDevToolsMessage(json.data(), json.size());
}

int NextDevToolsId() {
  if (!g_state) return 1;
  return g_state->devtools_id.fetch_add(1);
}

bool DevToolsMethod(const std::string& method, const std::string& params_json = "{}") {
  const int id = NextDevToolsId();
  const std::string msg =
    "{\"id\":" + std::to_string(id) +
    ",\"method\":\"" + jsonEscape(method) +
    "\",\"params\":" + (params_json.empty() ? "{}" : params_json) +
    "}";
  return SendDevToolsRaw(msg);
}

void EnableDevToolsControlDomains() {
  DevToolsMethod("Runtime.enable");
  DevToolsMethod("DOM.enable");
  if (enableAccessibilityLayer()) {
    DevToolsMethod("Accessibility.enable");
  }
  DevToolsMethod("Page.enable");
  DevToolsMethod("Input.setIgnoreInputEvents", "{\"ignore\":false}");
}

void ForceDesktopEmulation(const std::string& user_agent, int width, int height, double dpr) {
  DevToolsMethod(
    "Emulation.setUserAgentOverride",
    "{\"userAgent\":" + jsonQuote(user_agent) + ",\"platform\":\"macOS\"}"
  );
  DevToolsMethod(
    "Emulation.setTouchEmulationEnabled",
    "{\"enabled\":false}"
  );

  // Do not override metrics by default. In CEF OSR, GetViewRect/WasResized is
  // already the source of truth. DevTools metrics override before or during
  // first paint can suppress OSR painting on macOS.
  if (enableDevToolsMetricsOverride()) {
    DevToolsMethod(
      "Emulation.setDeviceMetricsOverride",
      "{\"width\":" + std::to_string(std::max(1, width)) +
      ",\"height\":" + std::to_string(std::max(1, height)) +
      ",\"deviceScaleFactor\":" + std::to_string(std::max(1.0, dpr)) +
      ",\"mobile\":false}"
    );
  }
}

bool DevToolsInsertText(const std::string& text) {
  if (text.empty()) return true;
  return DevToolsMethod("Input.insertText", "{\"text\":" + jsonQuote(text) + "}");
}

class DevToolsObserver : public CefDevToolsMessageObserver {
 public:
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    std::string payload = result && result_size > 0
      ? std::string(static_cast<const char*>(result), result_size)
      : "{}";
    SendDevToolsEvent(success ? "methodResult" : "methodError",
                      "{\"id\":" + std::to_string(message_id) + ",\"result\":" + payload + "}");
  }

  void OnDevToolsEvent(CefRefPtr<CefBrowser>,
                       const CefString& method,
                       const void* params,
                       size_t params_size) override {
    std::string payload = params && params_size > 0
      ? std::string(static_cast<const char*>(params), params_size)
      : "{}";
    SendDevToolsEvent(method.ToString(), payload);
  }

 private:
  IMPLEMENT_REFCOUNTING(DevToolsObserver);
};

std::atomic<int> g_ax_tree_events{0};
std::atomic<int> g_ax_location_events{0};
std::atomic<int64_t> g_last_ax_emit_ms{0};

void SendAccessibilityEvent(const std::string& kind, CefRefPtr<CefValue> value) {
  if (!enableAccessibilityLayer()) return;

  if (kind == "tree") g_ax_tree_events.fetch_add(1);
  if (kind == "location") g_ax_location_events.fetch_add(1);

  const int64_t now = nowMs();
  const int throttle = accessibilityThrottleMs();
  const int64_t last = g_last_ax_emit_ms.load();

  if (!enableAccessibilityVerbose() && now - last < throttle) return;
  g_last_ax_emit_ms.store(now);

  if (enableAccessibilityVerbose()) {
    SendMetadataJson(
      "{\"type\":\"accessibility\",\"kind\":\"" +
      jsonEscape(kind) +
      "\",\"payload\":" +
      jsonFromCefValue(value) +
      "}"
    );
    return;
  }

  SendMetadataJson(
    "{\"type\":\"accessibility\",\"kind\":\"summary\",\"treeEvents\":" +
    std::to_string(g_ax_tree_events.exchange(0)) +
    ",\"locationEvents\":" +
    std::to_string(g_ax_location_events.exchange(0)) +
    "}"
  );
}

void InitializeDevToolsLayerAfterFirstPaint() {
  CEF_REQUIRE_UI_THREAD();
  if (!enableDevToolsLayer()) return;
  if (!g_browser || !g_state) return;

  bool expected = false;
  if (!g_devtools_initialized.compare_exchange_strong(expected, true)) return;

  std::fprintf(stderr, "[cef] initializing DevTools layer after first paint\n");

  g_browser->GetHost()->AddDevToolsMessageObserver(new DevToolsObserver());
  EnableDevToolsControlDomains();
  ForceDesktopEmulation(
    defaultDesktopUserAgent(),
    g_state->view_w.load(),
    g_state->view_h.load(),
    g_state->dpr
  );

  ForcePaint();
}

class InitDevToolsLayerTask : public CefTask {
 public:
  void Execute() override {
    CEF_REQUIRE_UI_THREAD();
    InitializeDevToolsLayerAfterFirstPaint();
  }

 private:
  IMPLEMENT_REFCOUNTING(InitDevToolsLayerTask);
};

int keyCodeFor(const std::string& key);

std::string devToolsKeyName(const std::string& key) {
  if (key == "Space") return " ";
  return key;
}

bool DevToolsDispatchKey(const std::string& type, const std::string& key, int modifiers) {
  const std::string k = devToolsKeyName(key);
  int code = keyCodeFor(k);
  const std::string params =
    "{\"type\":\"" + jsonEscape(type) +
    "\",\"key\":" + jsonQuote(k) +
    ",\"code\":" + jsonQuote(k.size() == 1 ? ("Key" + std::string(1, static_cast<char>(std::toupper(k[0])))) : k) +
    ",\"windowsVirtualKeyCode\":" + std::to_string(code) +
    ",\"nativeVirtualKeyCode\":" + std::to_string(code) +
    ",\"modifiers\":" + std::to_string(modifiers) +
    "}";
  return DevToolsMethod("Input.dispatchKeyEvent", params);
}

bool DevToolsKeyPress(const std::string& key, int modifiers) {
  if (!DevToolsDispatchKey("keyDown", key, modifiers)) return false;
  const bool shortcut = (modifiers & (EVENTFLAG_CONTROL_DOWN | EVENTFLAG_COMMAND_DOWN | EVENTFLAG_ALT_DOWN)) != 0;
  if (key.size() == 1 && !shortcut) {
    DevToolsDispatchKey("char", key, modifiers);
  }
  return DevToolsDispatchKey("keyUp", key, modifiers);
}

void InstallSemanticBridge();

int g_pressed_mouse_flags = 0;

void FocusBrowser() {
  if (!g_browser) return;
  g_browser->GetHost()->SetFocus(true);
}

int mouseFlagFor(CefBrowserHost::MouseButtonType button) {
  switch (button) {
    case MBT_LEFT: return EVENTFLAG_LEFT_MOUSE_BUTTON;
    case MBT_MIDDLE: return EVENTFLAG_MIDDLE_MOUSE_BUTTON;
    case MBT_RIGHT: return EVENTFLAG_RIGHT_MOUSE_BUTTON;
    default: return 0;
  }
}

int clampClickCount(double v) {
  int n = static_cast<int>(v);
  return std::max(1, std::min(n, 3));
}

int cefKeyModifiersFromJson(const std::string& json) {
  int m = 0;
  if (jsonBool(json, "shift")) m |= EVENTFLAG_SHIFT_DOWN;
  if (jsonBool(json, "ctrl")) m |= EVENTFLAG_CONTROL_DOWN;
  if (jsonBool(json, "alt")) m |= EVENTFLAG_ALT_DOWN;
  if (jsonBool(json, "meta")) m |= EVENTFLAG_COMMAND_DOWN;
  return m;
}

int cefModifiersFromCore(uint32_t modifiers) {
  int m = 0;
  if (modifiers & KITTY_CORE_MOD_SHIFT) m |= EVENTFLAG_SHIFT_DOWN;
  if (modifiers & KITTY_CORE_MOD_CTRL) m |= EVENTFLAG_CONTROL_DOWN;
  if (modifiers & KITTY_CORE_MOD_ALT) m |= EVENTFLAG_ALT_DOWN;
  if (modifiers & KITTY_CORE_MOD_META) m |= EVENTFLAG_COMMAND_DOWN;
  return m;
}

int cefModifiersFromJson(const std::string& json) {
  return cefKeyModifiersFromJson(json);
}

CefBrowserHost::MouseButtonType cefButton(const std::string& button) {
  if (button == "right") return MBT_RIGHT;
  if (button == "middle") return MBT_MIDDLE;
  return MBT_LEFT;
}

CefBrowserHost::MouseButtonType cefButtonFromCore(uint32_t button) {
  if (button == KITTY_CORE_BUTTON_RIGHT) return MBT_RIGHT;
  if (button == KITTY_CORE_BUTTON_MIDDLE) return MBT_MIDDLE;
  return MBT_LEFT;
}

bool isBrowserNavigationKey(const std::string& key) {
  return key == "BrowserBack" ||
         key == "BrowserForward" ||
         key == "GoBack" ||
         key == "GoForward";
}

bool isBrowserNavigationShortcut(const std::string& key, int modifiers) {
  const bool alt_or_meta = (modifiers & (EVENTFLAG_ALT_DOWN | EVENTFLAG_COMMAND_DOWN)) != 0;
  if (!alt_or_meta) return false;

  if (key == "ArrowLeft" || key == "Left") return true;
  if (key == "ArrowRight" || key == "Right") return true;

  // Common browser shortcuts:
  //   macOS: Cmd+[ / Cmd+]
  //   many mouse utilities: Alt+[ / Alt+]
  if (key == "[" || key == "BracketLeft") return true;
  if (key == "]" || key == "BracketRight") return true;

  return false;
}

int64_t g_last_nav_button_ms = 0;
uint32_t g_last_nav_button = KITTY_CORE_BUTTON_NONE;

bool isBrowserNavigationButton(uint32_t button) {
  return button == KITTY_CORE_BUTTON_BACK || button == KITTY_CORE_BUTTON_FORWARD;
}

void HandleBrowserNavigationButton(uint32_t button) {
  if (!g_browser) return;
  FocusBrowser();

  const bool can_back = g_browser->CanGoBack();
  const bool can_forward = g_browser->CanGoForward();
  std::string url = "";
  if (g_browser->GetMainFrame()) url = g_browser->GetMainFrame()->GetURL().ToString();

  std::fprintf(
    stderr,
    "[cef] nav button=%u canBack=%d canForward=%d url=%s\n",
    button,
    can_back ? 1 : 0,
    can_forward ? 1 : 0,
    url.c_str()
  );

  const int64_t now = nowMs();
  if (button == g_last_nav_button && now - g_last_nav_button_ms < 250) return;
  g_last_nav_button = button;
  g_last_nav_button_ms = now;

  if (button == KITTY_CORE_BUTTON_BACK) {
    if (can_back) {
      g_browser->GoBack();
    } else if (g_browser->GetMainFrame()) {
      g_browser->GetMainFrame()->ExecuteJavaScript("history.back()", g_browser->GetMainFrame()->GetURL(), 0);
    }
    return;
  }

  if (button == KITTY_CORE_BUTTON_FORWARD) {
    if (can_forward) {
      g_browser->GoForward();
    } else if (g_browser->GetMainFrame()) {
      g_browser->GetMainFrame()->ExecuteJavaScript("history.forward()", g_browser->GetMainFrame()->GetURL(), 0);
    }
    return;
  }
}

void HandleBrowserNavigationKey(const std::string& key) {
  if (key == "BrowserBack" || key == "GoBack") {
    HandleBrowserNavigationButton(KITTY_CORE_BUTTON_BACK);
  } else if (key == "BrowserForward" || key == "GoForward") {
    HandleBrowserNavigationButton(KITTY_CORE_BUTTON_FORWARD);
  }
}

void HandleBrowserNavigationShortcut(const std::string& key, int modifiers) {
  if ((key == "ArrowLeft" || key == "Left" || key == "[" || key == "BracketLeft") &&
      (modifiers & (EVENTFLAG_ALT_DOWN | EVENTFLAG_COMMAND_DOWN))) {
    HandleBrowserNavigationButton(KITTY_CORE_BUTTON_BACK);
    return;
  }
  if ((key == "ArrowRight" || key == "Right" || key == "]" || key == "BracketRight") &&
      (modifiers & (EVENTFLAG_ALT_DOWN | EVENTFLAG_COMMAND_DOWN))) {
    HandleBrowserNavigationButton(KITTY_CORE_BUTTON_FORWARD);
    return;
  }
}

int keyCodeFor(const std::string& key) {
  if (key == "Enter") return 0x0D;
  if (key == "Backspace") return 0x08;
  if (key == "Tab") return 0x09;
  if (key == "Escape") return 0x1B;
  if (key == "Insert") return 0x2D;
  if (key == "Delete") return 0x2E;
  if (key == "ArrowLeft") return 0x25;
  if (key == "ArrowUp") return 0x26;
  if (key == "ArrowRight") return 0x27;
  if (key == "ArrowDown") return 0x28;
  if (key == "Home") return 0x24;
  if (key == "End") return 0x23;
  if (key == "PageUp") return 0x21;
  if (key == "PageDown") return 0x22;
  if (key == "Space") return 0x20;
  if (key.size() >= 2 && key[0] == 'F') {
    int n = std::atoi(key.c_str() + 1);
    if (n >= 1 && n <= 24) return 0x70 + (n - 1);
  }
  if (key.size() == 1) {
    unsigned char c = static_cast<unsigned char>(key[0]);
    if (c >= 'a' && c <= 'z') return static_cast<int>(c - 'a' + 'A');
    return static_cast<int>(c);
  }
  return 0;
}

void SendKey(const std::string& key, int modifiers) {
  if (!g_browser) return;
  int code = keyCodeFor(key);
  if (!code) return;
  FocusBrowser();

  CefKeyEvent down;
  down.type = KEYEVENT_RAWKEYDOWN;
  down.windows_key_code = code;
  down.native_key_code = code;
  down.modifiers = modifiers;
  down.focus_on_editable_field = true;
  g_browser->GetHost()->SendKeyEvent(down);

  const bool shortcut = (modifiers & (EVENTFLAG_CONTROL_DOWN | EVENTFLAG_COMMAND_DOWN)) != 0;
  if (key.size() == 1 && !shortcut) {
    CefKeyEvent ch;
    ch.type = KEYEVENT_CHAR;
    ch.windows_key_code = code;
    ch.native_key_code = code;
    ch.character = static_cast<char16_t>(static_cast<unsigned char>(key[0]));
    ch.unmodified_character = ch.character;
    ch.modifiers = modifiers;
    ch.focus_on_editable_field = true;
    g_browser->GetHost()->SendKeyEvent(ch);
  }

  CefKeyEvent up;
  up.type = KEYEVENT_KEYUP;
  up.windows_key_code = code;
  up.native_key_code = code;
  up.modifiers = modifiers;
  up.focus_on_editable_field = true;
  g_browser->GetHost()->SendKeyEvent(up);
}

void ExecuteInFocusedFrame(const std::string& js) {
  if (!g_browser) return;
  CefRefPtr<CefFrame> frame = g_browser->GetFocusedFrame();
  if (!frame) frame = g_browser->GetMainFrame();
  if (!frame) return;
  frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

void ExecuteCoreScript(const char* js) {
  if (!js || !*js) return;
  ExecuteInFocusedFrame(js);
}

void InsertTextViaDom(const std::string& text) {
  if (text.empty() || !g_state || !g_state->core) return;
  FocusBrowser();
  ExecuteCoreScript(kitty_core_build_insert_text_js(g_state->core, text.c_str()));
}

void InsertTextSmart(const std::string& text) {
  if (text.empty()) return;
  FocusBrowser();

  // Layer 1: Chromium DevTools Input.insertText. This is the most native path
  // for committed IME text, Japanese, emoji, symbols, and input[type=number].
  if (DevToolsInsertText(text)) return;

  // Layer fallback: DOM policy helper.
  InsertTextViaDom(text);
}

void EditKeyViaDom(const std::string& key) {
  if (key.empty() || !g_state || !g_state->core) return;
  FocusBrowser();
  ExecuteCoreScript(kitty_core_build_edit_key_js(g_state->core, key.c_str()));
}

void KeySmart(const std::string& key, int modifiers) {
  if (key.empty()) return;
  FocusBrowser();

  if (isBrowserNavigationKey(key)) {
    HandleBrowserNavigationKey(key);
    return;
  }

  if (isBrowserNavigationShortcut(key, modifiers)) {
    HandleBrowserNavigationShortcut(key, modifiers);
    return;
  }

  // Backspace/Delete in editables are more reliable through DOM policy because
  // terminal focus, IME, and JS controlled inputs can otherwise desync.
  if ((key == "Backspace" || key == "Delete") && modifiers == 0) {
    EditKeyViaDom(key);
    return;
  }

  // Layer 1: DevTools key dispatch.
  if (DevToolsKeyPress(key, modifiers)) return;

  // Layer fallback: physical CEF key event.
  SendKey(key, modifiers);
}

void AssistEditableClick(int x, int y) {
  if (!g_state || !g_state->core) return;
  FocusBrowser();
  ExecuteCoreScript(kitty_core_build_assist_click_js(g_state->core, x, y));
}

bool enableHitTestLayer() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_HITTEST");
  if (!env || !*env) return true;
  return std::string(env) != "0" &&
         std::string(env) != "false" &&
         std::string(env) != "FALSE" &&
         std::string(env) != "no" &&
         std::string(env) != "NO";
}

int hitTestThrottleMs() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_HITTEST_THROTTLE_MS");
  if (!env || !*env) return 75;
  return clampInt(std::atoi(env), 0, 1000);
}

int hitTestMinDeltaPx() {
  const char* env = std::getenv("KITTY_WEB_UI_CEF_HITTEST_MIN_DELTA_PX");
  if (!env || !*env) return 8;
  return clampInt(std::atoi(env), 0, 100);
}

int64_t g_last_hit_test_ms = 0;
int g_last_hit_test_x = -1000000;
int g_last_hit_test_y = -1000000;

bool shouldRunHitTest(int x, int y) {
  if (!enableHitTestLayer()) return false;

  const int min_delta = hitTestMinDeltaPx();
  const int dx = std::abs(x - g_last_hit_test_x);
  const int dy = std::abs(y - g_last_hit_test_y);

  // If the pointer barely moved, do not re-run JS hit-test. Cursor shape is
  // already covered by CEF OnCursorChange, so hitTest is semantic metadata, not
  // a per-pixel requirement.
  if (dx < min_delta && dy < min_delta) return false;

  const int throttle = hitTestThrottleMs();
  const int64_t now = nowMs();
  if (throttle > 0 && g_last_hit_test_ms > 0 && now - g_last_hit_test_ms < throttle) {
    return false;
  }

  g_last_hit_test_ms = now;
  g_last_hit_test_x = x;
  g_last_hit_test_y = y;
  return true;
}

void RunHitTest(int x, int y) {
  if (!g_state || !g_state->core) return;
  if (!shouldRunHitTest(x, y)) return;
  ExecuteCoreScript(kitty_core_build_hit_test_js(g_state->core, x, y));
}

int64_t g_last_context_menu_ms = 0;

void ShowBrowserContextMenu(int x, int y) {
  if (!g_browser) return;

  const int64_t now = nowMs();
  if (now - g_last_context_menu_ms < 250) return;
  g_last_context_menu_ms = now;

  FocusBrowser();

  const bool can_back = g_browser->CanGoBack();
  const bool can_forward = g_browser->CanGoForward();

  CefRefPtr<CefFrame> frame = g_browser->GetFocusedFrame();
  if (!frame) frame = g_browser->GetMainFrame();
  if (!frame) return;

  const std::string js =
    "(() => {"
    "  const x = " + std::to_string(std::max(0, x)) + ";"
    "  const y = " + std::to_string(std::max(0, y)) + ";"
    "  const canBack = " + std::string(can_back ? "true" : "false") + ";"
    "  const canForward = " + std::string(can_forward ? "true" : "false") + ";"
    "  let old = document.getElementById('__kitty_cef_context_menu__');"
    "  if (old) old.remove();"
    "  const menu = document.createElement('div');"
    "  menu.id = '__kitty_cef_context_menu__';"
    "  menu.style.cssText = ["
    "    'position:fixed',"
    "    'left:' + Math.min(x, innerWidth - 220) + 'px',"
    "    'top:' + Math.min(y, innerHeight - 180) + 'px',"
    "    'z-index:2147483647',"
    "    'min-width:200px',"
    "    'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',"
    "    'background:#fff',"
    "    'color:#111',"
    "    'border:1px solid rgba(0,0,0,.25)',"
    "    'box-shadow:0 8px 24px rgba(0,0,0,.28)',"
    "    'border-radius:8px',"
    "    'padding:6px',"
    "    'user-select:none'"
    "  ].join(';');"
    "  const close = () => menu.remove();"
    "  const item = (label, enabled, action) => {"
    "    const el = document.createElement('div');"
    "    el.textContent = label;"
    "    el.style.cssText = ["
    "      'padding:7px 10px',"
    "      'border-radius:6px',"
    "      'cursor:' + (enabled ? 'default' : 'not-allowed'),"
    "      'opacity:' + (enabled ? '1' : '.35')"
    "    ].join(';');"
    "    if (enabled) {"
    "      el.addEventListener('mouseenter', () => el.style.background = 'rgba(0,0,0,.08)');"
    "      el.addEventListener('mouseleave', () => el.style.background = 'transparent');"
    "      el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });"
    "      el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); close(); action(); });"
    "    }"
    "    menu.appendChild(el);"
    "  };"
    "  item('Back', canBack, () => history.back());"
    "  item('Forward', canForward, () => history.forward());"
    "  item('Reload', true, () => location.reload());"
    "  item('Copy page URL', true, async () => { try { await navigator.clipboard.writeText(location.href); } catch (_) {} });"
    "  document.body.appendChild(menu);"
    "  setTimeout(() => document.addEventListener('mousedown', close, { once:true, capture:true }), 0);"
    "})()";

  frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

void InstallSemanticBridge() {
  if (!enableMessageRouterLayer()) return;
  if (!g_browser) return;
  CefRefPtr<CefFrame> frame = g_browser->GetMainFrame();
  if (!frame) return;

  // Layer 2: MessageRouter bridge. Page agent sends semantic state to browser
  // process through window.kittyQuery(...). This is not used for pixel input;
  // it supplies focus/composition/selection/active-element diagnostics.
  const std::string js = R"JS(
(() => {
  if (window.__kitty_semantic_bridge_installed__) return;
  window.__kitty_semantic_bridge_installed__ = true;
  const send = (kind, payload = {}) => {
    try {
      if (typeof window.kittyQuery === 'function') {
        window.kittyQuery({ request: JSON.stringify({ type: 'semantic', kind, payload }) });
      }
    } catch (_) {}
  };
  const describe = (el) => {
    if (!el) return null;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const role = String(el.getAttribute?.('role') || '');
    const editable = !!(el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button','checkbox','radio','range','color','file','submit','reset','image','hidden'].includes(type)));
    return {
      tag, type, role, editable,
      id: String(el.id || ''),
      name: String(el.getAttribute?.('name') || ''),
      label: String(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || ''),
      valueLength: typeof el.value === 'string' ? el.value.length : undefined
    };
  };
  document.addEventListener('focusin', e => send('focusin', { active: describe(e.target) }), true);
  document.addEventListener('focusout', e => send('focusout', { active: describe(e.target) }), true);
  document.addEventListener('selectionchange', () => {
    const el = document.activeElement;
    let selection = null;
    try {
      if (el && typeof el.selectionStart === 'number') {
        selection = { start: el.selectionStart, end: el.selectionEnd };
      } else {
        const s = getSelection();
        selection = s ? { textLength: String(s.toString()).length, rangeCount: s.rangeCount } : null;
      }
    } catch (_) {}
    send('selectionchange', { active: describe(el), selection });
  }, true);
  document.addEventListener('compositionstart', e => send('compositionstart', { data: String(e.data || '') }), true);
  document.addEventListener('compositionupdate', e => send('compositionupdate', { data: String(e.data || '') }), true);
  document.addEventListener('compositionend', e => send('compositionend', { data: String(e.data || '') }), true);
  document.addEventListener('beforeinput', e => send('beforeinput', { inputType: e.inputType, data: String(e.data || '') }), true);
  document.addEventListener('input', e => send('input', { active: describe(e.target), inputType: e.inputType, data: String(e.data || '') }), true);
  send('bridge-installed', { active: describe(document.activeElement) });
})();
)JS";

  frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

class CommandTask : public CefTask {
 public:
  explicit CommandTask(std::string json) : json_(std::move(json)) {}

  void Execute() override {
    CEF_REQUIRE_UI_THREAD();
    if (!g_browser || !g_state) return;

    if (jsonString(json_, "type") == "frameAck") {
      if (!enableFrameAck()) return;
      const uint64_t seq = static_cast<uint64_t>(std::max(0.0, jsonNumber(json_, "seq", 0)));
      uint64_t current = g_state->acked_frame_seq.load(std::memory_order_relaxed);
      while (seq > current &&
             !g_state->acked_frame_seq.compare_exchange_weak(current, seq, std::memory_order_relaxed)) {}
      if (g_state->debug && seq <= 2) {
        std::fprintf(stderr, "[cef] frame ack seq=%llu\n", static_cast<unsigned long long>(seq));
      }
      // Seed the Rust renderer's hidden animation frame with a self-contained
      // full frame. A dirty-only seed can become transparent on some Kitty
      // versions because animation background-copy semantics differ.
      if (g_state->staging_seed_needed.exchange(false, std::memory_order_relaxed)) {
        kitty_core_force_full_frame(g_state->core);
        ForcePaint();
      } else if (g_state->missed_paint.load(std::memory_order_relaxed)) {
        // Paints may have been coalesced while Kitty was busy. Invalidate after
        // ACK so CEF supplies the latest complete buffer even if no new animation
        // tick happens naturally.
        ForcePaint();
      }
      return;
    }

    KittyCoreCommandMeta cmd{};
    const int parse_rc = kitty_core_parse_command_json(
      g_state->core,
      reinterpret_cast<const uint8_t*>(json_.data()),
      json_.size(),
      &cmd
    );

    if (parse_rc != 0) {
      std::fprintf(stderr, "[cef] rust command parse failed rc=%d error=%s json=%s\n",
                   parse_rc,
                   kitty_core_last_error(g_state->core),
                   json_.c_str());
      return;
    }

    if (cmd.kind == KITTY_CORE_CMD_STOP) {
      CefQuitMessageLoop();
      return;
    }
    if (cmd.kind == KITTY_CORE_CMD_NAVIGATE) {
      const std::string url = cmd.url_ptr ? cmd.url_ptr : "";
      if (startsWithAllowedScheme(url, g_state->allow_http)) g_browser->GetMainFrame()->LoadURL(url);
      return;
    }
    if (cmd.kind == KITTY_CORE_CMD_RESIZE) {
      int w = clampInt(static_cast<int>(cmd.width), 1, 16384);
      int h = clampInt(static_cast<int>(cmd.height), 1, 16384);
      if (w != g_state->view_w.load() || h != g_state->view_h.load()) {
        g_state->view_w.store(w);
        g_state->view_h.store(h);
        g_state->generation.fetch_add(1);
        g_state->staging_seed_needed.store(true, std::memory_order_relaxed);
      }
      g_browser->GetHost()->WasResized();
      return;
    }

    CefMouseEvent ev;
    ev.x = cmd.x;
    ev.y = cmd.y;
    ev.modifiers = cefModifiersFromCore(cmd.modifiers) | g_pressed_mouse_flags;

    if (cmd.kind == KITTY_CORE_CMD_CLICK) {
      FocusBrowser();
      if (isBrowserNavigationButton(cmd.button)) {
        HandleBrowserNavigationButton(cmd.button);
        return;
      }
      const auto button = cefButtonFromCore(cmd.button);
      const int click_count = clampClickCount(cmd.click_count);
      g_browser->GetHost()->SendMouseMoveEvent(ev, false);
      ev.modifiers |= mouseFlagFor(button);
      g_browser->GetHost()->SendMouseClickEvent(ev, button, false, click_count);
      g_browser->GetHost()->SendMouseClickEvent(ev, button, true, click_count);
      if (button == MBT_RIGHT) ShowBrowserContextMenu(ev.x, ev.y);
    } else if (cmd.kind == KITTY_CORE_CMD_MOUSE_DOWN) {
      FocusBrowser();
      if (isBrowserNavigationButton(cmd.button)) {
        // Some terminals only send press for side buttons. Navigate on press.
        HandleBrowserNavigationButton(cmd.button);
        return;
      }
      const auto button = cefButtonFromCore(cmd.button);
      const int click_count = clampClickCount(cmd.click_count);
      g_browser->GetHost()->SendMouseMoveEvent(ev, false);
      ev.modifiers |= mouseFlagFor(button);
      g_browser->GetHost()->SendMouseClickEvent(ev, button, false, click_count);
      g_pressed_mouse_flags |= mouseFlagFor(button);
    } else if (cmd.kind == KITTY_CORE_CMD_MOUSE_UP) {
      FocusBrowser();
      if (isBrowserNavigationButton(cmd.button)) {
        // Some terminals only send release for side buttons. Debounce in
        // HandleBrowserNavigationButton prevents double-navigation.
        HandleBrowserNavigationButton(cmd.button);
        return;
      }
      const auto button = cefButtonFromCore(cmd.button);
      const int click_count = clampClickCount(cmd.click_count);
      ev.modifiers |= mouseFlagFor(button);
      g_browser->GetHost()->SendMouseClickEvent(ev, button, true, click_count);
      g_pressed_mouse_flags &= ~mouseFlagFor(button);
      if (button == MBT_RIGHT) ShowBrowserContextMenu(ev.x, ev.y);
    } else if (cmd.kind == KITTY_CORE_CMD_MOUSE_MOVE) {
      if (!isBrowserNavigationButton(cmd.button)) {
        const auto button = cefButtonFromCore(cmd.button);
        if (cmd.button != KITTY_CORE_BUTTON_NONE) ev.modifiers |= mouseFlagFor(button);
      }
      g_browser->GetHost()->SendMouseMoveEvent(ev, false);
      // Hit-test is semantic metadata. Do not run it for every pixel movement;
      // it creates JS + console/message traffic and can compete with video
      // rendering on sites like YouTube.
      RunHitTest(ev.x, ev.y);
    } else if (cmd.kind == KITTY_CORE_CMD_WHEEL) {
      FocusBrowser();
      g_browser->GetHost()->SendMouseWheelEvent(ev, cmd.delta_x, cmd.delta_y);
    } else if (cmd.kind == KITTY_CORE_CMD_KEY) {
      const std::string key = cmd.key_ptr ? cmd.key_ptr : "";
      const int mods = cefModifiersFromCore(cmd.modifiers);
      KeySmart(key, mods);
    } else if (cmd.kind == KITTY_CORE_CMD_TEXT) {
      InsertTextSmart(cmd.text_ptr ? cmd.text_ptr : "");
    }
  }

 private:
  std::string json_;
  IMPLEMENT_REFCOUNTING(CommandTask);
};

void StartStdinReader() {
  std::thread([] {
    std::vector<uint8_t> buf;
    while (true) {
      uint8_t chunk[4096];
      ssize_t n = ::read(STDIN_FILENO, chunk, sizeof(chunk));
      if (n <= 0) break;
      buf.insert(buf.end(), chunk, chunk + n);
      while (buf.size() >= 4) {
        uint32_t len = static_cast<uint32_t>(buf[0]) |
                       (static_cast<uint32_t>(buf[1]) << 8) |
                       (static_cast<uint32_t>(buf[2]) << 16) |
                       (static_cast<uint32_t>(buf[3]) << 24);
        if (len > 1'048'576) { buf.clear(); break; }
        if (buf.size() < 4 + len) break;
        std::string json(reinterpret_cast<const char*>(buf.data() + 4), len);
        CefPostTask(TID_UI, new CommandTask(std::move(json)));
        buf.erase(buf.begin(), buf.begin() + 4 + len);
      }
    }
  }).detach();
}

class KittyCefClient : public CefClient,
                       public CefRenderHandler,
                       public CefDisplayHandler,
                       public CefAccessibilityHandler,
                       public CefContextMenuHandler,
                       public CefLifeSpanHandler,
                       public CefLoadHandler,
                       public CefRequestHandler,
                       public CefDownloadHandler {
 public:
  explicit KittyCefClient(RuntimeState* state) : state_(state) {}

  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefAccessibilityHandler> GetAccessibilityHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }

  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    if (!enableMessageRouterLayer()) return false;
    if (state_->message_router &&
        state_->message_router->OnProcessMessageReceived(browser, frame, source_process, message)) {
      return true;
    }
    return false;
  }

  void OnAccessibilityTreeChange(CefRefPtr<CefValue> value) override {
    SendAccessibilityEvent("tree", value);
  }

  void OnAccessibilityLocationChange(CefRefPtr<CefValue> value) override {
    SendAccessibilityEvent("location", value);
  }

  bool OnCursorChange(CefRefPtr<CefBrowser>,
                      CefCursorHandle,
                      cef_cursor_type_t type,
                      const CefCursorInfo&) override {
    const std::string cursor = cefCursorShape(type);
    if (cursor == last_cursor_) return false;
    last_cursor_ = cursor;
    if (state_->core) {
      const char* json = kitty_core_build_cursor_event_json(state_->core, cursor.c_str());
      if (json && *json) SendMetadataJson(json);
    }
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    if (!enableMessageRouterLayer()) return;
    if (state_->message_router) {
      state_->message_router->OnBeforeClose(browser);
      state_->message_router = nullptr;
    }
  }

  bool OnConsoleMessage(CefRefPtr<CefBrowser>,
                        cef_log_severity_t,
                        const CefString& message,
                        const CefString&,
                        int) override {
    if (!state_->core) return false;
    const std::string msg = message.ToString();
    const char* json = kitty_core_strip_hit_test_console_prefix(state_->core, msg.c_str());
    if (!json || !*json) return false;
    SendMetadataJson(json);
    return true;
  }

  void OnBeforeContextMenu(CefRefPtr<CefBrowser>,
                           CefRefPtr<CefFrame>,
                           CefRefPtr<CefContextMenuParams>,
                           CefRefPtr<CefMenuModel> model) override {
    // OSR has no native popup surface in this terminal UI. Keep the model empty
    // and render a lightweight page overlay from RunContextMenu / right-click
    // fallback.
    model->Clear();
  }

  bool RunContextMenu(CefRefPtr<CefBrowser>,
                      CefRefPtr<CefFrame>,
                      CefRefPtr<CefContextMenuParams> params,
                      CefRefPtr<CefMenuModel>,
                      CefRefPtr<CefRunContextMenuCallback> callback) override {
    ShowBrowserContextMenu(params->GetXCoord(), params->GetYCoord());
    if (callback) callback->Cancel();
    return true;
  }

  void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override {
    rect = CefRect(0, 0, state_->view_w.load(), state_->view_h.load());
  }

  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type, const RectList& dirty_rects,
               const void* buffer, int width, int height) override {
    if (type != PET_VIEW || !state_->server.Connected() || width <= 0 || height <= 0) return;

    // Do not silently drop the first OSR frame. Some CEF/macOS configurations
    // first paint at a slightly different backing size before settling. If we
    // drop that frame, Kitty stays blank and no later paint may be scheduled.
    const bool size_mismatch =
      std::abs(width - state_->view_w.load()) > 2 ||
      std::abs(height - state_->view_h.load()) > 2;
    if (size_mismatch && state_->debug) {
      std::fprintf(stderr,
        "[cef] accepting size-mismatched paint source=%dx%d expected=%dx%d\n",
        width,
        height,
        state_->view_w.load(),
        state_->view_h.load());
    }

    const bool first_paint = !g_first_paint_seen.exchange(true);

    if (!first_paint && shouldDropPaintForFlowControl()) {
      state_->missed_paint.store(true, std::memory_order_relaxed);
      const uint64_t dropped = state_->flow_dropped_frames.fetch_add(1, std::memory_order_relaxed) + 1;
      if (state_->debug && (dropped <= 5 || dropped % 120 == 0)) {
        const uint64_t sent = state_->sent_frame_seq.load(std::memory_order_relaxed);
        const uint64_t acked = state_->acked_frame_seq.load(std::memory_order_relaxed);
        std::fprintf(stderr,
          "[cef] drop paint flow-control sent=%llu acked=%llu maxUnacked=%llu dropped=%llu\n",
          static_cast<unsigned long long>(sent),
          static_cast<unsigned long long>(acked),
          static_cast<unsigned long long>(maxUnackedFrames()),
          static_cast<unsigned long long>(dropped));
      }
      return;
    }

    if (!state_->core) {
      std::fprintf(stderr, "[cef] rust core is null\n");
      return;
    }

    KittyCoreFrameMeta meta{};
    const PaintDirtyRect dirty = mergePaintDirtyRects(dirty_rects, width, height);
    // If any paint was skipped, CEF's current dirty rect does not necessarily
    // include all changes since the last delivered frame. Search the full
    // current buffer once; cef-core will still emit the minimal bounding delta.
    const bool recover_missed_paint = state_->missed_paint.exchange(false, std::memory_order_relaxed);
    const size_t bgra_len = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    const int rc = kitty_core_write_bgra_frame(
      state_->core,
      buffer,
      bgra_len,
      static_cast<uint32_t>(width),
      static_cast<uint32_t>(height),
      state_->rgb,
      recover_missed_paint ? 0u : (dirty.valid ? 1u : 0u),
      recover_missed_paint ? 0u : dirty.x,
      recover_missed_paint ? 0u : dirty.y,
      recover_missed_paint ? 0u : dirty.width,
      recover_missed_paint ? 0u : dirty.height,
      &meta
    );

    if (rc == 1) {
      return;
    }
    if (rc != 0) {
      std::fprintf(stderr, "[cef] rust frame write failed rc=%d error=%s\n",
                   rc,
                   kitty_core_last_error(state_->core));
      return;
    }

    const std::string transfer = meta.transfer_ptr ? meta.transfer_ptr : "file";

    std::ostringstream hdr;
    hdr << "{\"type\":\"" << (transfer == "direct" ? "frame" : "frameFile") << "\""
        << ",\"seq\":" << meta.seq
        << ",\"generation\":" << state_->generation.load()
        << ",\"width\":" << meta.width
        << ",\"height\":" << meta.height
        << ",\"stride\":" << meta.stride
        << ",\"format\":\"" << (state_->rgb ? "rgb" : "rgba") << "\""
        << ",\"transfer\":\"" << jsonEscape(transfer) << "\""
        << ",\"byteLength\":" << meta.byte_len;

    if (meta.dirty_valid) {
      hdr << ",\"dirty\":{\"x\":" << meta.dirty_x
          << ",\"y\":" << meta.dirty_y
          << ",\"width\":" << meta.dirty_width
          << ",\"height\":" << meta.dirty_height
          << "}";
    }

    if (transfer == "direct") {
      hdr << "}";
      if (!meta.data_ptr || meta.byte_len == 0) return;
      state_->server.SendFrame(hdr.str(), meta.data_ptr, meta.byte_len);
    } else {
      hdr << ",\"path\":\"" << jsonEscape(meta.path_ptr ? meta.path_ptr : "") << "\""
          << "}";
      state_->server.SendHeader(hdr.str());
    }

    state_->sent_frame_seq.store(meta.seq, std::memory_order_relaxed);

    if ((state_->debug && meta.seq <= 2) || envBool("KITTY_WEBVIEW_FRAME_DEBUG", false)) {
      std::fprintf(stderr, "[cef] frame %llu %ux%u bytes=%zu transfer=%s dirty=%ux%u@%u,%u cefDirty=%ux%u@%u,%u name=%s\n",
                   static_cast<unsigned long long>(meta.seq),
                   meta.width,
                   meta.height,
                   meta.byte_len,
                   transfer.c_str(),
                   meta.dirty_valid ? meta.dirty_width : 0,
                   meta.dirty_valid ? meta.dirty_height : 0,
                   meta.dirty_valid ? meta.dirty_x : 0,
                   meta.dirty_valid ? meta.dirty_y : 0,
                   dirty.valid ? dirty.width : 0,
                   dirty.valid ? dirty.height : 0,
                   dirty.valid ? dirty.x : 0,
                   dirty.valid ? dirty.y : 0,
                   meta.path_ptr ? meta.path_ptr : "");
    }

    if (first_paint && enableDevToolsLayer()) {
      // Keep the first OSR frame path clean. DevTools is enabled only after
      // Kitty has received a real frame.
      CefPostDelayedTask(TID_UI, new InitDevToolsLayerTask(), 250);
    }
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    g_browser = browser;
    g_browser_created.store(true);
    browser->GetHost()->SetWindowlessFrameRate(state_->fps);
    browser->GetHost()->SetFocus(true);

    if (enableAccessibilityLayer()) {
      browser->GetHost()->SetAccessibilityState(STATE_ENABLED);
    }

    if (state_->zoom_factor > 0 && state_->zoom_factor != 1.0) {
      // Chromium zoom level is log base 1.2 of the desired factor.
      browser->GetHost()->SetZoomLevel(std::log(state_->zoom_factor) / std::log(1.2));
    }
    StartStdinReader();
    std::fprintf(stderr, "[cef] browser created fps=%d zoom=%.3f initialSize=%dx%d\n",
                 state_->fps, state_->zoom_factor, state_->view_w.load(), state_->view_h.load());

    if (enableMessageRouterLayer()) InstallSemanticBridge();

    // Force a blank first paint before loading a heavy page. This proves the
    // OSR pixel pipeline is alive even when the target site aborts/restarts
    // navigation internally.
    browser->GetMainFrame()->LoadURL("about:blank");
    browser->GetHost()->WasResized();
    browser->GetHost()->Invalidate(PET_VIEW);
    CefPostDelayedTask(TID_UI, new ForcePaintUntilFirstFrameTask(30), 50);
    CefPostDelayedTask(TID_UI, new LoadInitialUrlTask(), 150);
  }

  bool OnBeforePopup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame>, int,
                     const CefString& target_url, const CefString&, WindowOpenDisposition,
                     bool, const CefPopupFeatures&, CefWindowInfo&, CefRefPtr<CefClient>&,
                     CefBrowserSettings&, CefRefPtr<CefDictionaryValue>&,
                     bool* no_javascript_access) override {
    if (no_javascript_access) *no_javascript_access = true;
    const std::string url = target_url.ToString();
    if (startsWithAllowedScheme(url, state_->allow_http)) browser->GetMainFrame()->LoadURL(url);
    return true;
  }

  bool OnBeforeBrowse(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest> request,
                      bool, bool) override {
    const std::string url = request->GetURL().ToString();
    if (!startsWithAllowedScheme(url, state_->allow_http)) {
      std::fprintf(stderr, "[cef] blocked navigation url=%s\n", url.c_str());
      return true;
    }
    return false;
  }

  bool OnCertificateError(CefRefPtr<CefBrowser>, cef_errorcode_t, const CefString& request_url,
                          CefRefPtr<CefSSLInfo>, CefRefPtr<CefCallback>) override {
    std::fprintf(stderr, "[cef] certificate error url=%s\n", request_url.ToString().c_str());
    return false;
  }

  bool OnBeforeDownload(CefRefPtr<CefBrowser>, CefRefPtr<CefDownloadItem> item,
                        const CefString&, CefRefPtr<CefBeforeDownloadCallback>) override {
    std::fprintf(stderr, "[cef] download denied url=%s\n", item->GetURL().ToString().c_str());
    return false;
  }

  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, int) override {
    if (frame->IsMain()) {
      std::fprintf(stderr, "[cef] page loaded\n");
      if (enableMessageRouterLayer()) InstallSemanticBridge();
      ForcePaint();
      CefPostDelayedTask(TID_UI, new ForcePaintUntilFirstFrameTask(10), 50);
    }
  }

  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, ErrorCode code,
                   const CefString& text, const CefString& failed_url) override {
    if (!frame->IsMain()) return;

    // ERR_ABORTED commonly means the page intentionally cancelled/replaced the
    // navigation. Treat it as informational; keep the current surface alive.
    if (code == ERR_ABORTED) {
      std::fprintf(stderr, "[cef] load aborted url=%s code=%d desc=%s\n",
                   failed_url.ToString().c_str(),
                   static_cast<int>(code),
                   text.ToString().c_str());
      ForcePaint();
      return;
    }

    std::fprintf(stderr, "[cef] load failed url=%s code=%d desc=%s\n",
                 failed_url.ToString().c_str(),
                 static_cast<int>(code),
                 text.ToString().c_str());
    ForcePaint();
  }

 private:
  RuntimeState* state_;
  std::string last_cursor_ = "default";
  IMPLEMENT_REFCOUNTING(KittyCefClient);
};

class KittyQueryHandler : public CefMessageRouterBrowserSide::Handler,
                               public CefBaseRefCounted {
 public:
  bool OnQuery(CefRefPtr<CefBrowser>,
               CefRefPtr<CefFrame>,
               int64_t query_id,
               const CefString& request,
               bool,
               CefRefPtr<Callback> callback) override {
    const std::string body = request.ToString();
    SendMetadataJson("{\"type\":\"messageRouter\",\"queryId\":" +
                     std::to_string(static_cast<long long>(query_id)) +
                     ",\"payload\":" + (body.empty() ? "null" : body) + "}");
    callback->Success("");
    return true;
  }

  void OnQueryCanceled(CefRefPtr<CefBrowser>,
                       CefRefPtr<CefFrame>,
                       int64_t query_id) override {
    SendMetadataJson("{\"type\":\"messageRouter\",\"kind\":\"canceled\",\"queryId\":" +
                     std::to_string(static_cast<long long>(query_id)) + "}");
  }

 private:
  IMPLEMENT_REFCOUNTING(KittyQueryHandler);
};

class KittyCefApp : public CefApp, public CefBrowserProcessHandler, public CefRenderProcessHandler {
 public:
  explicit KittyCefApp(RuntimeState* state) : state_(state) {}

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }

  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command_line) override {
    command_line->AppendSwitch("no-sandbox");
    command_line->AppendSwitch("disable-renderer-backgrounding");
    command_line->AppendSwitch("disable-background-timer-throttling");
    command_line->AppendSwitchWithValue("force-device-scale-factor", std::to_string(state_->dpr));
    command_line->AppendSwitchWithValue("touch-events", "disabled");
    command_line->AppendSwitch("disable-pinch");
    command_line->AppendSwitch("disable-touch-drag-drop");

    // Offscreen rendering into Kitty is a software-pixel pipeline. On macOS,
    // incomplete CEF app-bundle layouts often fail while launching the GPU
    // subprocess:
    //
    //   GPU process launch failed: error_code=1003
    //   GPU process isn't usable. Goodbye.
    //
    // Disable GPU by default. Set KITTY_WEB_UI_CEF_ENABLE_GPU=1 only after the
    // full CEF helper app bundle layout is correct.
    if (!envEnabled("KITTY_WEB_UI_CEF_ENABLE_GPU")) {
      command_line->AppendSwitch("disable-gpu");
      command_line->AppendSwitch("disable-gpu-compositing");
      command_line->AppendSwitch("disable-gpu-vsync");
      command_line->AppendSwitch("disable-zero-copy");
      command_line->AppendSwitch("disable-accelerated-2d-canvas");
      command_line->AppendSwitch("disable-accelerated-video-decode");
      command_line->AppendSwitch("disable-features=CanvasOopRasterization,UseSkiaRenderer");
    }

    // Debug escape hatch only. Do not use as the default once subprocess
    // packaging is fixed.
    if (envEnabled("KITTY_WEB_UI_CEF_SINGLE_PROCESS")) {
      command_line->AppendSwitch("single-process");
    }

    if (state_->site_profile == "stable") {
      command_line->AppendSwitchWithValue("autoplay-policy", "user-gesture-required");
      command_line->AppendSwitch("disable-smooth-scrolling");
    }
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();

    if (enableMessageRouterLayer()) {
      CefMessageRouterConfig router_config;
      router_config.js_query_function = "kittyQuery";
      router_config.js_cancel_function = "kittyCancel";
      state_->message_router = CefMessageRouterBrowserSide::Create(router_config);
      state_->message_router->AddHandler(new KittyQueryHandler(), false);
    }

    CefWindowInfo window_info;
    window_info.SetAsWindowless(kNullWindowHandle);

    CefBrowserSettings browser_settings;
    browser_settings.windowless_frame_rate = state_->fps;

    CefRefPtr<KittyCefClient> client = new KittyCefClient(state_);
    // Start with about:blank. The real URL is loaded from OnAfterCreated after
    // the OSR surface has been explicitly invalidated.
    CefBrowserHost::CreateBrowser(window_info, client, "about:blank", browser_settings, nullptr, nullptr);
  }

  void OnWebKitInitialized() override {
    if (!enableMessageRouterLayer()) return;
    CefMessageRouterConfig router_config;
    router_config.js_query_function = "kittyQuery";
    router_config.js_cancel_function = "kittyCancel";
    renderer_message_router_ = CefMessageRouterRendererSide::Create(router_config);
  }

  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override {
    if (renderer_message_router_) {
      renderer_message_router_->OnContextCreated(browser, frame, context);
    }
  }

  void OnContextReleased(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override {
    if (renderer_message_router_) {
      renderer_message_router_->OnContextReleased(browser, frame, context);
    }
  }

  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    if (!enableMessageRouterLayer()) return false;
    return renderer_message_router_ &&
           renderer_message_router_->OnProcessMessageReceived(browser, frame, source_process, message);
  }

 private:
  RuntimeState* state_;
  CefRefPtr<CefMessageRouterRendererSide> renderer_message_router_;
  IMPLEMENT_REFCOUNTING(KittyCefApp);
};

}  // namespace

int main(int argc, char** argv) {
  // CEF on macOS uses dynamic framework loading. Must load before any CEF API call.
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) {
    std::fprintf(stderr, "[cef] failed to load CEF framework\n");
    return 2;
  }

  RuntimeState state;
  g_state = &state;

  state.initial_url = argString(argc, argv, 1, "https://example.com");
  state.fps = clampInt(argInt(argc, argv, 2, 60), 1, 60);
  state.dpr = clampNumber(argDouble(argc, argv, 3, 1.0), 0.5, 4.0);
  state.zoom_factor = clampNumber(argDouble(argc, argv, 4, 1.0), 0.25, 5.0);
  const std::string nonce = argString(argc, argv, 5);
  state.allow_http = argString(argc, argv, 6) == "1";
  bool persist = argString(argc, argv, 7) == "1";
  state.debug = argString(argc, argv, 8) == "1";
  const std::string user_agent_arg = argString(argc, argv, 9);
  const std::string user_agent = user_agent_arg.empty() ? defaultDesktopUserAgent() : user_agent_arg;
  state.site_profile = argString(argc, argv, 10, "default");
  state.view_w.store(clampInt(argInt(argc, argv, 11, 1280), 1, 16384));
  state.view_h.store(clampInt(argInt(argc, argv, 12, 800), 1, 16384));
  state.rgb = std::getenv("KITTY_WEBVIEW_PIXEL_FORMAT") && std::string(std::getenv("KITTY_WEBVIEW_PIXEL_FORMAT")) == "rgb";

  CefMainArgs main_args(argc, argv);
  CefRefPtr<KittyCefApp> app = new KittyCefApp(&state);

  // Must happen before starting the browser-process-only TCP/file transport.
  // CEF subprocesses re-enter this executable with different argv.
  int exit_code = CefExecuteProcess(main_args, app, nullptr);
  std::fprintf(stderr, "[cef] CefExecuteProcess returned %d\n", exit_code);
  if (exit_code >= 0) return exit_code;

  state.core = kitty_core_new(state.debug);
  if (!state.core) {
    std::fprintf(stderr, "[cef] failed to create rust core\n");
    return 2;
  }

  if (!startsWithAllowedScheme(state.initial_url, state.allow_http)) {
    std::fprintf(stderr, "[cef] blocked initial url=%s\n", state.initial_url.c_str());
    kitty_core_free(state.core);
    state.core = nullptr;
    return 2;
  }
  if (nonce.empty() || !state.server.Start(nonce)) {
    std::fprintf(stderr, "[cef] failed to start frame server\n");
    kitty_core_free(state.core);
    state.core = nullptr;
    return 2;
  }

  CefSettings settings;
  settings.no_sandbox = true;
  settings.windowless_rendering_enabled = true;
  settings.background_color = CefColorSetARGB(255, 255, 255, 255);

  // Make subprocess launch explicit. This prevents CEF/Chromium from guessing
  // a helper app path that may not exist in the custom bundle.
  const std::string subprocess_path = resolveBrowserSubprocessPath();
  if (!subprocess_path.empty()) {
    CefString(&settings.browser_subprocess_path) = subprocess_path;
    if (state.debug) {
      std::fprintf(stderr, "[cef] browser_subprocess_path=%s\n", subprocess_path.c_str());
    }
  } else {
    std::fprintf(stderr, "[cef] warning: could not resolve browser_subprocess_path\n");
  }

  std::string root_cache_path;
  if (noDiskMode()) {
    // Strict no-disk mode for experiments. Leave CEF cache paths empty so the
    // browser profile/cache stays in memory as much as CEF allows.
    //
    // This does not promise that Chromium/OS will never touch disk internally,
    // but it removes this helper's explicit /tmp root_cache_path creation.
    CefString(&settings.root_cache_path) = "";
    CefString(&settings.cache_path) = "";
  } else {
    root_cache_path = persist
      ? persistentCefRootCachePath()
      : ephemeralCefRootCachePath();
    mkdirAll(root_cache_path);
    CefString(&settings.root_cache_path) = root_cache_path;

    if (persist) {
      const std::string cache_path = root_cache_path + "/Default";
      mkdirAll(cache_path);
      CefString(&settings.cache_path) = cache_path;
    } else {
      // Keep the browser profile off-disk, but still set root_cache_path.
      // Recent CEF versions warn if root_cache_path is left at the default.
      CefString(&settings.cache_path) = "";
    }
  }

  if (state.debug) {
    // Do not write Chromium's verbose CEF log to /tmp by default. Native
    // stderr is already captured into /tmp/kitty-webview-debug.log by the Bun
    // controller. Set KITTY_WEB_UI_CEF_LOG_FILE explicitly when a CEF internal
    // log file is needed.
    settings.log_severity = LOGSEVERITY_WARNING;
    const char* cef_log_file = std::getenv("KITTY_WEB_UI_CEF_LOG_FILE");
    if (cef_log_file && *cef_log_file) {
      CefString(&settings.log_file) = cef_log_file;
    }
  }

  CefString(&settings.user_agent) = user_agent;
  if (state.debug) {
    std::fprintf(stderr,
                 "[cef] root_cache_path=%s persist=%d noDisk=%d\n",
                 root_cache_path.empty() ? "(empty)" : root_cache_path.c_str(),
                 persist ? 1 : 0,
                 noDiskMode() ? 1 : 0);
  }

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    std::fprintf(stderr, "[cef] CefInitialize failed\n");
    state.server.Stop();
    kitty_core_free(state.core);
    state.core = nullptr;
    return 2;
  }
  std::fprintf(stderr, "[cef] CefInitialize succeeded, entering message loop\n");

  CefRunMessageLoop();
  std::fprintf(stderr, "[cef] message loop exited\n");
  CefShutdown();
  state.server.Stop();
  kitty_core_free(state.core);
  state.core = nullptr;
  return 0;
}
