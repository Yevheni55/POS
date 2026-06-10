// ============================================================================
// Surf Spirit POS — natívna Windows kasa (Win32 + WebView2, C++17)
//
// Tenký natívny shell nad webovou kasou (referenčná implementácia na serveri):
//   - kiosk fullscreen (F11 prepína), single-instance, ikona + verzia
//   - server URL v registry (HKCU\Software\SurfSpiritPOS), dialóg nastavení
//   - retry obrazovka pri výpadku spojenia s auto-reconnectom každých 5 s
//   - voliteľný auto-štart s Windows (Run kľúč)
//   - nové okná sa neotvárajú: rovnaký host = navigácia, cudzí = default browser
//
// Build: build.bat (MSVC + WebView2LoaderStatic.lib, /utf-8)
// Vyžaduje WebView2 Runtime (Windows 11 ho má v sebe, inak Evergreen installer).
// ============================================================================

#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wrl.h>
#include <string>
#include "../sdk/WebView2.h"
#include "resource.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

// ---------------------------------------------------------------------------
static const wchar_t* kWndClass   = L"SurfSpiritPOSWnd";
static const wchar_t* kMutexName  = L"SurfSpiritPOS_SingleInstance";
static const wchar_t* kRegKey     = L"Software\\SurfSpiritPOS";
static const wchar_t* kRunKey     = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const wchar_t* kRunValue   = L"SurfSpiritPOS";
static const UINT     kRetryTimer = 1;
static const UINT     kRetryMs    = 5000;

static HWND                          g_hwnd = nullptr;
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2>           g_webview;
static std::wstring                  g_serverUrl;     // napr. http://192.168.1.235:3080
static bool                          g_fullscreen = true;
static WINDOWPLACEMENT               g_restorePlacement{ sizeof(WINDOWPLACEMENT) };
static bool                          g_showingRetry = false;

// ---------------------------------------------------------------------------
// Registry config
// ---------------------------------------------------------------------------
static std::wstring RegReadStr(const wchar_t* name) {
    wchar_t buf[512]{}; DWORD len = sizeof(buf);
    HKEY h;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRegKey, 0, KEY_READ, &h) != ERROR_SUCCESS) return L"";
    DWORD type = 0;
    LONG rc = RegQueryValueExW(h, name, nullptr, &type, reinterpret_cast<BYTE*>(buf), &len);
    RegCloseKey(h);
    if (rc != ERROR_SUCCESS || type != REG_SZ) return L"";
    return buf;
}

static void RegWriteStr(const wchar_t* name, const std::wstring& val) {
    HKEY h;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRegKey, 0, nullptr, 0, KEY_WRITE, nullptr, &h, nullptr) != ERROR_SUCCESS) return;
    RegSetValueExW(h, name, 0, REG_SZ,
        reinterpret_cast<const BYTE*>(val.c_str()),
        static_cast<DWORD>((val.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(h);
}

static bool AutostartEnabled() {
    HKEY h; wchar_t buf[MAX_PATH * 2]{}; DWORD len = sizeof(buf);
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &h) != ERROR_SUCCESS) return false;
    LONG rc = RegQueryValueExW(h, kRunValue, nullptr, nullptr, reinterpret_cast<BYTE*>(buf), &len);
    RegCloseKey(h);
    return rc == ERROR_SUCCESS;
}

static void SetAutostart(bool on) {
    HKEY h;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_WRITE, &h) != ERROR_SUCCESS) return;
    if (on) {
        wchar_t exe[MAX_PATH]{};
        GetModuleFileNameW(nullptr, exe, MAX_PATH);
        std::wstring quoted = L"\"" + std::wstring(exe) + L"\"";
        RegSetValueExW(h, kRunValue, 0, REG_SZ,
            reinterpret_cast<const BYTE*>(quoted.c_str()),
            static_cast<DWORD>((quoted.size() + 1) * sizeof(wchar_t)));
    } else {
        RegDeleteValueW(h, kRunValue);
    }
    RegCloseKey(h);
}

// "192.168.1.235:3080" -> "http://192.168.1.235:3080" (bez koncového /)
static std::wstring NormalizeUrl(std::wstring s) {
    while (!s.empty() && (s.back() == L'/' || s.back() == L' ')) s.pop_back();
    size_t start = s.find_first_not_of(L' ');
    if (start == std::wstring::npos) return L"";
    s = s.substr(start);
    if (s.rfind(L"http://", 0) != 0 && s.rfind(L"https://", 0) != 0) s = L"http://" + s;
    return s;
}

// ---------------------------------------------------------------------------
// Retry obrazovka — inline HTML vo Warm Hearth identite (žiadne závislosti)
// ---------------------------------------------------------------------------
static std::wstring RetryHtml() {
    return LR"(<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8">
<style>
  body{margin:0;font-family:'Segoe UI',sans-serif;background:#FFF8F6;color:#281811;
       display:flex;align-items:center;justify-content:center;height:100vh}
  .card{text-align:center;max-width:420px;padding:40px}
  .badge{display:inline-block;background:#95442A;color:#FFF8F6;font-weight:800;
         padding:10px 16px;border-radius:14px;font-size:20px;letter-spacing:1px}
  h1{font-size:26px;margin:24px 0 10px}
  p{color:#55433D;line-height:1.6;margin:0}
  .spin{margin:28px auto 0;width:36px;height:36px;border-radius:50%;
        border:4px solid #FFE9E2;border-top-color:#95442A;animation:r 1s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation:none}}
  .url{margin-top:18px;font-size:13px;color:#6E5A53;font-family:Consolas,monospace}
</style></head><body><div class="card">
  <span class="badge">SSS</span>
  <h1>Server je nedostupný</h1>
  <p>Kasa sa nevie pripojiť k serveru. Skontroluj, či beží počítač kasy
     a sieť. Skúšam to znova každých pár sekúnd…</p>
  <div class="spin" role="status" aria-label="Pripájam sa"></div>
  <div class="url">)" + g_serverUrl + LR"(</div>
</div></body></html>)";
}

// ---------------------------------------------------------------------------
// Settings dialóg (server URL + autostart)
// ---------------------------------------------------------------------------
static INT_PTR CALLBACK SettingsDlgProc(HWND dlg, UINT msg, WPARAM wp, LPARAM) {
    switch (msg) {
    case WM_INITDIALOG:
        SetDlgItemTextW(dlg, IDC_SERVER_URL, g_serverUrl.c_str());
        CheckDlgButton(dlg, IDC_AUTOSTART, AutostartEnabled() ? BST_CHECKED : BST_UNCHECKED);
        return TRUE;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDOK: {
            wchar_t buf[512]{};
            GetDlgItemTextW(dlg, IDC_SERVER_URL, buf, 511);
            std::wstring url = NormalizeUrl(buf);
            if (url.empty()) {
                MessageBoxW(dlg, L"Zadaj adresu servera (napr. 192.168.1.235:3080).",
                            L"Surf Spirit POS", MB_ICONWARNING);
                return TRUE;
            }
            g_serverUrl = url;
            RegWriteStr(L"ServerUrl", url);
            SetAutostart(IsDlgButtonChecked(dlg, IDC_AUTOSTART) == BST_CHECKED);
            EndDialog(dlg, IDOK);
            return TRUE;
        }
        case IDCANCEL:
            EndDialog(dlg, IDCANCEL);
            return TRUE;
        }
        break;
    }
    return FALSE;
}

static bool ShowSettings(HWND owner) {
    return DialogBoxW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDD_SETTINGS),
                      owner, SettingsDlgProc) == IDOK;
}

// ---------------------------------------------------------------------------
// Fullscreen kiosk
// ---------------------------------------------------------------------------
static void ApplyFullscreen(bool on) {
    DWORD style = GetWindowLongW(g_hwnd, GWL_STYLE);
    if (on) {
        GetWindowPlacement(g_hwnd, &g_restorePlacement);
        MONITORINFO mi{ sizeof(mi) };
        GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY), &mi);
        SetWindowLongW(g_hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
        SetWindowPos(g_hwnd, HWND_TOP,
            mi.rcMonitor.left, mi.rcMonitor.top,
            mi.rcMonitor.right - mi.rcMonitor.left,
            mi.rcMonitor.bottom - mi.rcMonitor.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    } else {
        SetWindowLongW(g_hwnd, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
        SetWindowPlacement(g_hwnd, &g_restorePlacement);
        SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
    g_fullscreen = on;
}

static void ResizeWebView() {
    if (!g_controller) return;
    RECT rc; GetClientRect(g_hwnd, &rc);
    g_controller->put_Bounds(rc);
}

static void NavigateHome() {
    if (g_webview && !g_serverUrl.empty()) {
        g_showingRetry = false;
        g_webview->Navigate(g_serverUrl.c_str());
    }
}

// ---------------------------------------------------------------------------
// WebView2 init
// ---------------------------------------------------------------------------
static void InitWebView() {
    // Profil mimo inštalačného adresára — exe môže bežať aj z read-only miesta
    wchar_t base[MAX_PATH]{};
    SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, base);
    std::wstring userData = std::wstring(base) + L"\\SurfSpiritPOS";

    CreateCoreWebView2EnvironmentWithOptions(nullptr, userData.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(hr) || !env) {
                    MessageBoxW(g_hwnd,
                        L"WebView2 Runtime sa nepodarilo spustiť.\n"
                        L"Nainštaluj 'Microsoft Edge WebView2 Runtime' a skús znova.",
                        L"Surf Spirit POS", MB_ICONERROR);
                    PostQuitMessage(1);
                    return hr;
                }
                env->CreateCoreWebView2Controller(g_hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [](HRESULT hr2, ICoreWebView2Controller* ctrl) -> HRESULT {
                            if (FAILED(hr2) || !ctrl) { PostQuitMessage(1); return hr2; }
                            g_controller = ctrl;
                            g_controller->get_CoreWebView2(&g_webview);

                            ComPtr<ICoreWebView2Settings> st;
                            g_webview->get_Settings(&st);
                            if (st) {
                                st->put_AreDefaultContextMenusEnabled(FALSE); // kiosk
                                st->put_IsZoomControlEnabled(FALSE);          // mokré prsty
                                st->put_IsStatusBarEnabled(FALSE);
                            }

                            // Pád navigácie (server nebeží) -> retry obrazovka + časovač
                            g_webview->add_NavigationCompleted(
                                Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                    [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                        BOOL ok = FALSE;
                                        args->get_IsSuccess(&ok);
                                        if (!ok && !g_showingRetry) {
                                            g_showingRetry = true;
                                            g_webview->NavigateToString(RetryHtml().c_str());
                                            SetTimer(g_hwnd, kRetryTimer, kRetryMs, nullptr);
                                        } else if (ok && !g_showingRetry) {
                                            KillTimer(g_hwnd, kRetryTimer);
                                        }
                                        // úspešné zobrazenie retry stránky neresetuje flag —
                                        // ten zhasína až úspešná navigácia na server
                                        if (ok && g_showingRetry) g_showingRetry = false;
                                        return S_OK;
                                    }).Get(), nullptr);

                            // Žiadne popup okná: rovnaký server = naviguj tu,
                            // cudzí odkaz = systémový prehliadač
                            g_webview->add_NewWindowRequested(
                                Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                    [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                                        args->put_Handled(TRUE);
                                        LPWSTR uri = nullptr;
                                        if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                                            std::wstring u(uri);
                                            CoTaskMemFree(uri);
                                            if (u.rfind(g_serverUrl, 0) == 0) g_webview->Navigate(u.c_str());
                                            else ShellExecuteW(nullptr, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                                        }
                                        return S_OK;
                                    }).Get(), nullptr);

                            // Klávesy z webview (fokus má webview, nie naše okno):
                            // F11 fullscreen, F5 reload, Ctrl+, nastavenia, Ctrl+Q koniec
                            g_controller->add_AcceleratorKeyPressed(
                                Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                                    [](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) -> HRESULT {
                                        COREWEBVIEW2_KEY_EVENT_KIND kind;
                                        args->get_KeyEventKind(&kind);
                                        if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN &&
                                            kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
                                        UINT key = 0; args->get_VirtualKey(&key);
                                        bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
                                        if (key == VK_F11) { args->put_Handled(TRUE); ApplyFullscreen(!g_fullscreen); }
                                        else if (key == VK_F5) { args->put_Handled(TRUE); NavigateHome(); }
                                        else if (ctrl && key == VK_OEM_COMMA) {
                                            args->put_Handled(TRUE);
                                            PostMessageW(g_hwnd, WM_APP, 1, 0);
                                        } else if (ctrl && key == 'Q') {
                                            args->put_Handled(TRUE);
                                            PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
                                        }
                                        return S_OK;
                                    }).Get(), nullptr);

                            ResizeWebView();
                            NavigateHome();
                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());
}

// ---------------------------------------------------------------------------
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE:
        ResizeWebView();
        return 0;
    case WM_TIMER:
        if (wp == kRetryTimer && g_showingRetry) NavigateHome();
        return 0;
    case WM_APP: // nastavenia z accelerator handlera (mimo COM callbacku)
        if (ShowSettings(hwnd)) NavigateHome();
        return 0;
    case WM_CLOSE:
        // Kiosk poistka — náhodné Alt+F4 nesmie zhodiť kasu počas zmeny
        if (MessageBoxW(hwnd, L"Naozaj ukončiť kasu?", L"Surf Spirit POS",
                        MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES)
            DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---------------------------------------------------------------------------
int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    // Druhá inštancia len aktivuje bežiace okno — na kase nesmú bežať dve kasy
    HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = FindWindowW(kWndClass, nullptr);
        if (existing) { ShowWindow(existing, SW_RESTORE); SetForegroundWindow(existing); }
        return 0;
    }

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    g_serverUrl = RegReadStr(L"ServerUrl");

    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.lpszClassName = kWndClass;
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(IDI_APP));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = CreateSolidBrush(RGB(0xFF, 0xF8, 0xF6)); // Cream
    RegisterClassW(&wc);

    g_hwnd = CreateWindowExW(0, kWndClass, L"Surf Spirit POS",
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800,
        nullptr, nullptr, inst, nullptr);
    if (!g_hwnd) return 1;

    // Prvé spustenie bez konfigurácie -> dialóg; zrušenie = koniec
    if (g_serverUrl.empty() && !ShowSettings(g_hwnd)) {
        DestroyWindow(g_hwnd);
        CoUninitialize();
        return 0;
    }

    ShowWindow(g_hwnd, SW_SHOW);
    ApplyFullscreen(true);
    InitWebView();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }

    if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
    CoUninitialize();
    return 0;
}
