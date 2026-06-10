// ============================================================================
// REST klient na POS server — WinHTTP + nlohmann/json.
//
// Všetky volania bežia na worker vlákne (UI sa nesmie zaseknúť počas
// fiškalizácie); výsledok sa doručí cez PostMessage(WM_API_DONE) a callback
// sa vykoná na UI vlákne. Idempotency kľúče zrkadlia Android Api.kt:
// retry rovnakej operácie drží TEN ISTÝ kľúč — server replayne výsledok
// namiesto druhého dokladu/bonu.
// ============================================================================
#pragma once
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <functional>
#include <thread>
#include <mutex>
#include <deque>
#include <random>
#include "json.hpp"

#pragma comment(lib, "winhttp.lib")

using nlohmann::json;

constexpr UINT WM_API_DONE = WM_APP + 7;

struct ApiResult {
    bool ok = false;          // 2xx
    int  status = 0;          // HTTP status; 0 = transport chyba
    json body;                // parsované telo (može byť null)
    std::wstring error;       // ľudská hláška pri transport chybe
    bool isTimeout = false;
    bool isConnectFail = false;
};

using ApiCallback = std::function<void(ApiResult&)>;

namespace ApiDetail {
    struct Job {
        std::wstring method, path, idemKey;
        std::string  body;          // UTF-8 JSON ("" = bez tela)
        int          readTimeoutMs;
        ApiCallback  cb;
        ApiResult    res;
    };
    inline std::mutex              mx;
    inline std::deque<Job*>        queue;
    inline std::deque<Job*>        done;
    inline HWND                    notifyWnd{};
    inline std::wstring            baseHost;      // "192.168.1.235"
    inline INTERNET_PORT           basePort = 3080;
    inline bool                    baseTls = false;
    inline std::wstring            token;         // JWT
    inline bool                    running = false;

    inline std::string ToUtf8(const std::wstring& w) {
        if (w.empty()) return {};
        int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
        std::string s(n, 0);
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
        return s;
    }
    inline std::wstring ToWide(const std::string& s) {
        if (s.empty()) return {};
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
        std::wstring w(n, 0);
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
        return w;
    }

    inline void Execute(Job* j) {
        ApiResult& r = j->res;
        HINTERNET ses = WinHttpOpen(L"SurfSpiritPOS-Win/1.0",
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!ses) { r.error = L"WinHTTP init zlyhal"; return; }
        // connect 8 s, send 10 s, receive podľa jobu (platba 60 s — Portos)
        WinHttpSetTimeouts(ses, 8000, 8000, 10000, j->readTimeoutMs);

        HINTERNET con = WinHttpConnect(ses, baseHost.c_str(), basePort, 0);
        HINTERNET req = con ? WinHttpOpenRequest(con, j->method.c_str(), j->path.c_str(),
            nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
            baseTls ? WINHTTP_FLAG_SECURE : 0) : nullptr;

        if (req) {
            std::wstring hdrs = L"Content-Type: application/json\r\n";
            if (!token.empty())      hdrs += L"Authorization: Bearer " + token + L"\r\n";
            if (!j->idemKey.empty()) hdrs += L"X-Idempotency-Key: " + j->idemKey + L"\r\n";

            BOOL sent = WinHttpSendRequest(req, hdrs.c_str(), (DWORD)hdrs.size(),
                j->body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)j->body.data(),
                (DWORD)j->body.size(), (DWORD)j->body.size(), 0);
            if (sent && WinHttpReceiveResponse(req, nullptr)) {
                DWORD status = 0, len = sizeof(status);
                WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
                r.status = (int)status;
                std::string data;
                for (;;) {
                    DWORD avail = 0;
                    if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
                    size_t off = data.size();
                    data.resize(off + avail);
                    DWORD read = 0;
                    if (!WinHttpReadData(req, data.data() + off, avail, &read)) break;
                    data.resize(off + read);
                }
                if (!data.empty()) r.body = json::parse(data, nullptr, false);
                r.ok = status >= 200 && status < 300;
                if (!r.ok) {
                    if (r.body.is_object() && r.body.contains("error") && r.body["error"].is_string())
                        r.error = ToWide(r.body["error"].get<std::string>());
                    else r.error = L"Chyba servera (" + std::to_wstring(status) + L")";
                }
            } else {
                DWORD e = GetLastError();
                r.isTimeout    = (e == ERROR_WINHTTP_TIMEOUT);
                r.isConnectFail = (e == ERROR_WINHTTP_CANNOT_CONNECT ||
                                   e == ERROR_WINHTTP_NAME_NOT_RESOLVED);
                r.error = r.isTimeout ? L"Server neodpovedal včas."
                                      : L"Server je nedostupný — skontroluj sieť.";
            }
        } else {
            r.isConnectFail = true;
            r.error = L"Server je nedostupný — skontroluj sieť.";
        }
        if (req) WinHttpCloseHandle(req);
        if (con) WinHttpCloseHandle(con);
        WinHttpCloseHandle(ses);
    }

    inline void WorkerLoop() {
        for (;;) {
            Job* j = nullptr;
            {
                std::lock_guard<std::mutex> l(mx);
                if (!queue.empty()) { j = queue.front(); queue.pop_front(); }
            }
            if (!j) { Sleep(15); continue; }
            Execute(j);
            {
                std::lock_guard<std::mutex> l(mx);
                done.push_back(j);
            }
            PostMessageW(notifyWnd, WM_API_DONE, 0, 0);
        }
    }
}

namespace Api {
    inline void Init(HWND notify) {
        ApiDetail::notifyWnd = notify;
        if (!ApiDetail::running) {
            ApiDetail::running = true;
            std::thread(ApiDetail::WorkerLoop).detach();
        }
    }

    /** "http://192.168.1.235:3080" -> host/port/tls */
    inline void SetServer(std::wstring url) {
        using namespace ApiDetail;
        baseTls = url.rfind(L"https://", 0) == 0;
        size_t p = url.find(L"://");
        if (p != std::wstring::npos) url = url.substr(p + 3);
        while (!url.empty() && url.back() == L'/') url.pop_back();
        p = url.find(L':');
        if (p != std::wstring::npos) {
            basePort = (INTERNET_PORT)_wtoi(url.substr(p + 1).c_str());
            baseHost = url.substr(0, p);
        } else {
            baseHost = url;
            basePort = baseTls ? 443 : 80;
        }
    }
    inline void SetToken(const std::wstring& t) { ApiDetail::token = t; }
    inline bool HasServer() { return !ApiDetail::baseHost.empty(); }

    inline std::wstring NewKey(const wchar_t* prefix) {
        static std::mt19937_64 rng{ std::random_device{}() };
        wchar_t b[64];
        swprintf(b, 64, L"%s-%08x%08x", prefix, (unsigned)rng(), (unsigned)rng());
        return b;
    }

    /** Asynchrónne volanie; cb beží na UI vlákne (po WM_API_DONE -> Pump()). */
    inline void Call(const std::wstring& method, const std::wstring& path,
                     const json& body, ApiCallback cb,
                     const std::wstring& idemKey = L"", int readTimeoutMs = 20000) {
        auto* j = new ApiDetail::Job();
        j->method = method;
        j->path = path;
        j->idemKey = idemKey;
        j->readTimeoutMs = readTimeoutMs;
        if (!body.is_null()) j->body = body.dump();
        j->cb = std::move(cb);
        std::lock_guard<std::mutex> l(ApiDetail::mx);
        ApiDetail::queue.push_back(j);
    }
    inline void Get(const std::wstring& path, ApiCallback cb) {
        Call(L"GET", path, nullptr, std::move(cb));
    }

    /** Volaj z WndProc pri WM_API_DONE — vykoná hotové callbacky na UI vlákne. */
    inline void Pump() {
        for (;;) {
            ApiDetail::Job* j = nullptr;
            {
                std::lock_guard<std::mutex> l(ApiDetail::mx);
                if (!ApiDetail::done.empty()) { j = ApiDetail::done.front(); ApiDetail::done.pop_front(); }
            }
            if (!j) break;
            if (j->cb) j->cb(j->res);
            delete j;
        }
    }
}
