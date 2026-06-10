// ============================================================================
// Surf Spirit POS — natívny Windows framework (Direct2D + DirectWrite)
//
// Immediate-mode UI: každý frame sa scéna KRESLÍ aj HIT-TESTUJE v jednom
// prechode (Button() vráti true, keď naň v tomto frame prišiel tap).
// Žiadny retained widget strom — minimum kódu, plná kontrola nad vizuálom.
// Tokeny zrkadlia ui/theme (Warm Hearth) z Android/web verzie.
// ============================================================================
#pragma once
#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <windowsx.h>
#include <d2d1_1.h>
#include <dwrite.h>
#include <string>
#include <vector>
#include <functional>
#include <cmath>

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")

// Pozn.: windows.h makro DrawText premenovalo aj DEKLARÁCIU v d2d1.h na
// DrawTextW — preto sa metóda volá cez makro (rt->DrawText expanduje
// rovnako na oboch stranách). Žiadny #undef!

// ----------------------------------------------------------------- tokeny --
namespace Th {
    // Farby (Warm Hearth — Theme.kt parita)
    constexpr UINT32 Cream        = 0xFFF8F6;
    constexpr UINT32 CreamElev    = 0xFFF1EC;
    constexpr UINT32 CreamSunken  = 0xFFE9E2;
    constexpr UINT32 Terra        = 0x95442A;
    constexpr UINT32 TerraLight   = 0xB45C3F;
    constexpr UINT32 TerraDim     = 0x793017;
    constexpr UINT32 Sage         = 0x4A7A3A;
    constexpr UINT32 Amber        = 0xB87C1A;
    constexpr UINT32 Navy         = 0x1F3A5C;
    constexpr UINT32 Danger       = 0xBA1A1A;
    constexpr UINT32 Espresso     = 0x281811;
    constexpr UINT32 EspressoSoft = 0x55433D;
    constexpr UINT32 EspressoDim  = 0x6E5A53;
    constexpr UINT32 Border       = 0x88726C;   // používaj s alfou ~0.22f

    // Radius / spacing (Dimens.kt parita)
    constexpr float RXS = 4, RSM = 8, RMD = 14, RLG = 22;
    constexpr float S1 = 4, S2 = 8, S3 = 12, S4 = 16, S5 = 20, S6 = 24, S8 = 32;
    constexpr float MinTouch = 48;
}

// ------------------------------------------------------------------- app ---
struct App {
    HWND hwnd{};
    ID2D1Factory*          d2f{};
    IDWriteFactory*        dwf{};
    ID2D1HwndRenderTarget* rt{};
    ID2D1SolidColorBrush*  brush{};

    // text formáty (Plus Jakarta nie je systémový — Segoe UI je natívny dvojník)
    IDWriteTextFormat *fBody{}, *fBodyBold{}, *fLabel{}, *fTitle{}, *fHero{}, *fSmall{};

    // vstup pre immediate-mode (jeden tap na frame)
    POINT tap{ -1, -1 };
    bool  tapped = false;
    POINT mouse{ -1, -1 };

    float W = 0, H = 0;          // klientske rozmery v DIP
    float dpiScale = 1.f;

    std::function<void()> frame;          // kreslí aktuálnu obrazovku
    std::function<void(UINT)> onKey;      // VK_* pri WM_KEYDOWN
    std::function<void(wchar_t)> onChar;  // WM_CHAR (poznámky, URL)

    // ---- init ----
    bool InitDeviceResources() {
        if (rt) return true;
        RECT rc; GetClientRect(hwnd, &rc);
        D2D1_SIZE_U size = D2D1::SizeU(rc.right - rc.left, rc.bottom - rc.top);
        if (FAILED(d2f->CreateHwndRenderTarget(
                D2D1::RenderTargetProperties(),
                D2D1::HwndRenderTargetProperties(hwnd, size), &rt))) return false;
        rt->CreateSolidColorBrush(D2D1::ColorF(0), &brush);
        return true;
    }
    void DiscardDeviceResources() {
        if (brush) { brush->Release(); brush = nullptr; }
        if (rt)    { rt->Release();    rt = nullptr; }
    }

    IDWriteTextFormat* MakeFormat(float px, DWRITE_FONT_WEIGHT w) {
        IDWriteTextFormat* f{};
        dwf->CreateTextFormat(L"Segoe UI", nullptr, w, DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL, px, L"sk-SK", &f);
        return f;
    }
    void InitFonts() {
        fSmall    = MakeFormat(12, DWRITE_FONT_WEIGHT_SEMI_BOLD);
        fLabel    = MakeFormat(14, DWRITE_FONT_WEIGHT_SEMI_BOLD);
        fBody     = MakeFormat(16, DWRITE_FONT_WEIGHT_NORMAL);
        fBodyBold = MakeFormat(16, DWRITE_FONT_WEIGHT_BOLD);
        fTitle    = MakeFormat(22, DWRITE_FONT_WEIGHT_BOLD);
        fHero     = MakeFormat(34, DWRITE_FONT_WEIGHT_EXTRA_BOLD);
    }

    void Invalidate() { InvalidateRect(hwnd, nullptr, FALSE); }

    // ---- kreslenie ----
    static D2D1_COLOR_F C(UINT32 rgb, float a = 1.f) {
        return D2D1::ColorF(((rgb >> 16) & 0xFF) / 255.f,
                            ((rgb >> 8) & 0xFF) / 255.f,
                            (rgb & 0xFF) / 255.f, a);
    }
    void Fill(D2D1_RECT_F r, UINT32 rgb, float rad = 0, float a = 1.f) {
        brush->SetColor(C(rgb, a));
        if (rad > 0) rt->FillRoundedRectangle(D2D1::RoundedRect(r, rad, rad), brush);
        else rt->FillRectangle(r, brush);
    }
    void Stroke(D2D1_RECT_F r, UINT32 rgb, float rad = 0, float a = 1.f, float w = 1.f) {
        brush->SetColor(C(rgb, a));
        if (rad > 0) rt->DrawRoundedRectangle(D2D1::RoundedRect(r, rad, rad), brush, w);
        else rt->DrawRectangle(r, brush, w);
    }
    void Text(D2D1_RECT_F r, const std::wstring& s, IDWriteTextFormat* f, UINT32 rgb,
              DWRITE_TEXT_ALIGNMENT ha = DWRITE_TEXT_ALIGNMENT_LEADING,
              DWRITE_PARAGRAPH_ALIGNMENT va = DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
              float a = 1.f) {
        f->SetTextAlignment(ha);
        f->SetParagraphAlignment(va);
        f->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        brush->SetColor(C(rgb, a));
        rt->DrawText(s.c_str(), (UINT32)s.size(), f, r, brush,
                     D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
    void TextWrap(D2D1_RECT_F r, const std::wstring& s, IDWriteTextFormat* f, UINT32 rgb,
                  DWRITE_TEXT_ALIGNMENT ha = DWRITE_TEXT_ALIGNMENT_LEADING) {
        f->SetTextAlignment(ha);
        f->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        f->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
        brush->SetColor(C(rgb));
        rt->DrawText(s.c_str(), (UINT32)s.size(), f, r, brush);
    }

    // ---- immediate-mode prvky ----
    bool Hit(D2D1_RECT_F r, POINT p) const {
        return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    }
    bool Clicked(D2D1_RECT_F r) {
        return tapped && Hit(r, tap);
    }
    bool Hover(D2D1_RECT_F r) const { return Hit(r, mouse); }

    /** Plné tlačidlo (primár = Terra/Cream). Vráti true pri tape. */
    bool Button(D2D1_RECT_F r, const std::wstring& label, UINT32 bg = Th::Terra,
                UINT32 fg = Th::Cream, IDWriteTextFormat* f = nullptr, bool enabled = true) {
        if (!f) f = fBodyBold;
        float a = enabled ? (Hover(r) ? 0.92f : 1.f) : 0.45f;
        Fill(r, bg, Th::RMD, a);
        Text(r, label, f, fg, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
             enabled ? 1.f : 0.7f);
        return enabled && Clicked(r);
    }
    /** Obrysové tlačidlo. */
    bool GhostButton(D2D1_RECT_F r, const std::wstring& label, UINT32 fg = Th::Espresso,
                     IDWriteTextFormat* f = nullptr, bool enabled = true) {
        if (!f) f = fBodyBold;
        if (Hover(r) && enabled) Fill(r, Th::CreamElev, Th::RMD);
        Stroke(r, Th::Border, Th::RMD, enabled ? 0.34f : 0.18f);
        Text(r, label, f, fg, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
             enabled ? 1.f : 0.45f);
        return enabled && Clicked(r);
    }
    /** Karta s jemným okrajom. */
    void Card(D2D1_RECT_F r, UINT32 bg = Th::CreamElev, float rad = Th::RMD) {
        Fill(r, bg, rad);
        Stroke(r, Th::Border, rad, 0.22f);
    }
};

inline App g_app;

// utily
inline D2D1_RECT_F R(float x, float y, float w, float h) {
    return D2D1::RectF(x, y, x + w, y + h);
}
inline std::wstring Money(double v) {
    wchar_t b[64];
    swprintf(b, 64, L"%.2f €", v);
    for (wchar_t* p = b; *p; ++p) if (*p == L'.') *p = L',';
    return b;
}
