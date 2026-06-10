// ============================================================================
// Surf Spirit POS — natívna Windows kasa (vstupný bod)
// Win32 okno + Direct2D render slučka + WinHTTP API. Build: build-native.bat
// ============================================================================
#include "app.h"
#include "api.h"
#include "screens.h"

static const wchar_t* kClass = L"SurfSpiritPOSNative";
static const wchar_t* kMutex = L"SurfSpiritPOSNative_Single";
static bool g_fullscreen = false;
static WINDOWPLACEMENT g_place{ sizeof(g_place) };

constexpr UINT TIMER_POLL  = 1;   // floor refresh 15 s
constexpr UINT TIMER_CLOCK = 2;   // hodiny v hlavičke

static void ToggleFullscreen(HWND h) {
    DWORD style = GetWindowLongW(h, GWL_STYLE);
    if (!g_fullscreen) {
        GetWindowPlacement(h, &g_place);
        MONITORINFO mi{ sizeof(mi) };
        GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTOPRIMARY), &mi);
        SetWindowLongW(h, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
        SetWindowPos(h, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
            mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    } else {
        SetWindowLongW(h, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
        SetWindowPlacement(h, &g_place);
        SetWindowPos(h, nullptr, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
    g_fullscreen = !g_fullscreen;
}

static std::wstring ReadServerUrl() {
    wchar_t buf[512]{}; DWORD len = sizeof(buf);
    HKEY h;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\SurfSpiritPOS", 0, KEY_READ, &h) != ERROR_SUCCESS)
        return L"";
    RegQueryValueExW(h, L"ServerUrl", nullptr, nullptr, (BYTE*)buf, &len);
    RegCloseKey(h);
    return buf;
}

static void Render() {
    if (!g_app.InitDeviceResources()) return;
    RECT rc; GetClientRect(g_app.hwnd, &rc);
    g_app.W = (float)(rc.right - rc.left);
    g_app.H = (float)(rc.bottom - rc.top);

    g_app.rt->BeginDraw();
    DrawFrame();
    g_app.tapped = false;   // tap spotrebovaný týmto frame-om
    HRESULT hr = g_app.rt->EndDraw();
    if (hr == D2DERR_RECREATE_TARGET) g_app.DiscardDeviceResources();
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps; BeginPaint(h, &ps);
        Render();
        EndPaint(h, &ps);
        return 0;
    }
    case WM_SIZE:
        if (g_app.rt) g_app.rt->Resize(D2D1::SizeU(LOWORD(lp), HIWORD(lp)));
        g_app.Invalidate();
        return 0;
    case WM_LBUTTONDOWN:
        g_app.tap = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
        g_app.tapped = true;
        g_app.Invalidate();
        return 0;
    case WM_MOUSEMOVE:
        g_app.mouse = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
        return 0;
    case WM_KEYDOWN:
        if (wp == VK_F11) { ToggleFullscreen(h); return 0; }
        if (wp == VK_F5) {
            if (S.screen == Screen::Floor) LoadFloor(false);
            return 0;
        }
        HandleKey((UINT)wp);
        return 0;
    case WM_CHAR:
        HandleChar((wchar_t)wp);
        return 0;
    case WM_TIMER:
        if (wp == TIMER_POLL && S.screen == Screen::Floor && !S.payOpen) LoadFloor(true);
        if (wp == TIMER_CLOCK) g_app.Invalidate();
        return 0;
    case WM_API_DONE:
        Api::Pump();
        return 0;
    case WM_CLOSE:
        if (MessageBoxW(h, L"Naozaj ukončiť kasu?", L"Surf Spirit POS",
                        MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES)
            DestroyWindow(h);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutex);
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND ex = FindWindowW(kClass, nullptr);
        if (ex) { ShowWindow(ex, SW_RESTORE); SetForegroundWindow(ex); }
        return 0;
    }
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_app.d2f);
    DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                        reinterpret_cast<IUnknown**>(&g_app.dwf));
    g_app.InitFonts();

    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.lpszClassName = kClass;
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(101));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&wc);

    g_app.hwnd = CreateWindowExW(0, kClass, L"Surf Spirit POS",
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1366, 860,
        nullptr, nullptr, inst, nullptr);
    if (!g_app.hwnd) return 1;

    Api::Init(g_app.hwnd);
    std::wstring url = ReadServerUrl();
    if (url.empty()) {
        S.screen = Screen::Setup;
    } else {
        Api::SetServer(url);
        S.screen = Screen::Login;
    }

    SetTimer(g_app.hwnd, TIMER_POLL, 15000, nullptr);
    SetTimer(g_app.hwnd, TIMER_CLOCK, 30000, nullptr);

    ShowWindow(g_app.hwnd, SW_SHOW);

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }

    if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
    CoUninitialize();
    return 0;
}
