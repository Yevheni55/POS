// ============================================================================
// Obrazovky natívnej kasy — Login (PIN) / Mapa stolov / Objednávka / Platba.
// Immediate-mode nad app.h; dáta cez api.h. Slovenčina, Warm Hearth.
//
// Idempotencia (parita s Android OrderScreen):
//  - createKey: nový pri KAŽDEJ zmene košíka — retry nezmeneného košíka
//    po výpadku NEduplikuje položky
//  - sendKey:   per účet, rotuje LEN po úspešnom sende (obsahový hash nie —
//    sync preklápa lokálne riadky na serverové id)
//  - payKey:    nový pri otvorení platobného dialógu; retry/recheck drží
//    TEN ISTÝ kľúč -> server replayne výsledok, nikdy druhý doklad
// ============================================================================
#pragma once
#include "app.h"
#include "api.h"
#include <algorithm>
#include <map>

enum class Screen { Setup, Login, Floor, Order };

struct MenuItem { int id; std::wstring name, emoji; double price; };
struct Category { int id; std::wstring label, icon; std::vector<MenuItem> items; };
struct CartLine { int menuItemId; std::wstring name, emoji; double price; int qty; };

struct PosState {
    Screen screen = Screen::Login;

    // setup
    std::wstring urlInput;

    // auth
    std::wstring pin, userName, role;
    bool loginBusy = false;
    std::wstring loginError;

    // dáta
    json zones = json::array();
    json tables = json::array();
    std::vector<Category> menu;
    std::map<int, double> tableTotals;     // tableId -> suma otvorených účtov
    std::map<int, int>    tableAccounts;   // tableId -> počet účtov
    std::wstring activeZone;
    int  failStreak = 0;                   // OFFLINE banner až po 2 zlyhaniach
    bool offline = false;

    // objednávka
    int  tableId = 0;
    std::wstring tableName;
    json order;                            // aktuálny serverový účet (alebo null)
    std::vector<CartLine> cart;
    int  activeCat = 0;
    bool busy = false;
    std::wstring orderError;

    std::wstring createKey, sendKey, payKey;

    // platba
    bool payOpen = false;
    std::wstring payMethod = L"hotovost";
    std::wstring payGiven;                 // text "20" / "20,50"
    bool payBusy = false;
    std::wstring payError, payNote;
    bool payUnclear = false;               // timeout/processing -> Skontrolovať znova
    double payAmount = 0;

    // toast
    std::wstring toast;
    UINT32 toastColor = Th::Sage;
    ULONGLONG toastUntil = 0;
};

inline PosState S;

inline void ShowToast(const std::wstring& msg, UINT32 color = Th::Sage) {
    S.toast = msg; S.toastColor = color;
    S.toastUntil = GetTickCount64() + 3500;
    g_app.Invalidate();
}

inline void ReportNet(bool ok) {
    if (ok) { S.failStreak = 0; S.offline = false; }
    else if (++S.failStreak >= 2) S.offline = true;
}

// ----------------------------------------------------------------- loady ---
inline void LoadFloor(bool quiet);

inline void LoadMenu() {
    Api::Get(L"/api/menu", [](ApiResult& r) {
        if (!r.ok || !r.body.is_array()) return;
        S.menu.clear();
        for (auto& c : r.body) {
            Category cat;
            cat.id = c.value("id", 0);
            cat.label = ApiDetail::ToWide(c.value("label", ""));
            cat.icon = ApiDetail::ToWide(c.value("icon", ""));
            for (auto& it : c.value("items", json::array())) {
                MenuItem m;
                m.id = it.value("id", 0);
                m.name = ApiDetail::ToWide(it.value("name", ""));
                m.emoji = ApiDetail::ToWide(it.value("emoji", ""));
                m.price = it.value("price", 0.0);
                if (it["price"].is_string()) m.price = _wtof(ApiDetail::ToWide(it["price"].get<std::string>()).c_str());
                cat.items.push_back(m);
            }
            if (!cat.items.empty()) S.menu.push_back(cat);
        }
        if (S.activeCat >= (int)S.menu.size()) S.activeCat = 0;
        g_app.Invalidate();
    });
}

inline void LoadFloor(bool quiet) {
    Api::Get(L"/api/tables", [](ApiResult& r) {
        ReportNet(r.ok);
        if (r.ok && r.body.is_array()) {
            S.tables = r.body;
            if (S.activeZone.empty() && !S.tables.empty())
                S.activeZone = ApiDetail::ToWide(S.tables[0].value("zone", ""));
        }
        g_app.Invalidate();
    });
    Api::Get(L"/api/orders", [](ApiResult& r) {
        if (!r.ok || !r.body.is_array()) return;
        S.tableTotals.clear(); S.tableAccounts.clear();
        for (auto& o : r.body) {
            int tid = o.value("tableId", 0);
            double t = 0;
            if (o.contains("grandTotal")) {
                if (o["grandTotal"].is_number()) t = o["grandTotal"].get<double>();
                else if (o["grandTotal"].is_string()) t = atof(o["grandTotal"].get<std::string>().c_str());
            }
            S.tableTotals[tid] += t;
            S.tableAccounts[tid] += 1;
        }
        g_app.Invalidate();
    });
}

inline void OpenTable(int tableId, const std::wstring& name) {
    S.tableId = tableId; S.tableName = name;
    S.order = nullptr; S.cart.clear();
    S.orderError.clear();
    S.createKey = Api::NewKey(L"create");
    S.sendKey = Api::NewKey(L"send");
    S.screen = Screen::Order;
    Api::Get(L"/api/orders/table/" + std::to_wstring(tableId), [](ApiResult& r) {
        if (r.ok && r.body.is_array() && !r.body.empty()) S.order = r.body[0];
        g_app.Invalidate();
    });
    g_app.Invalidate();
}

// ------------------------------------------------------------- order ops ---
inline double OrderTotal() {
    double t = 0;
    if (S.order.is_object()) {
        if (S.order.contains("grandTotal")) {
            auto& g = S.order["grandTotal"];
            t += g.is_number() ? g.get<double>() : atof(g.get<std::string>().c_str());
        }
    }
    for (auto& l : S.cart) t += l.price * l.qty;
    return t;
}

inline void AddToCart(const MenuItem& m) {
    for (auto& l : S.cart)
        if (l.menuItemId == m.id) { l.qty++; S.createKey = Api::NewKey(L"create"); g_app.Invalidate(); return; }
    S.cart.push_back({ m.id, m.name, m.emoji, m.price, 1 });
    S.createKey = Api::NewKey(L"create");
    g_app.Invalidate();
}

inline json CartItemsJson() {
    json items = json::array();
    for (auto& l : S.cart)
        items.push_back({ {"menuItemId", l.menuItemId}, {"qty", l.qty}, {"note", ""} });
    return items;
}

/** Sync košíka na server, potom next(orderId). Pri prázdnom košíku ide rovno next. */
inline void SyncCart(std::function<void(int)> next) {
    if (S.cart.empty()) {
        next(S.order.is_object() ? S.order.value("id", 0) : 0);
        return;
    }
    auto after = [next](ApiResult& r) {
        S.busy = false;
        if (!r.ok) {
            S.orderError = r.error.empty() ? L"Synchronizácia zlyhala." : r.error;
            g_app.Invalidate();
            return;
        }
        S.cart.clear();
        // refresh účtu a pokračuj
        Api::Get(L"/api/orders/table/" + std::to_wstring(S.tableId), [next](ApiResult& r2) {
            if (r2.ok && r2.body.is_array() && !r2.body.empty()) S.order = r2.body[0];
            next(S.order.is_object() ? S.order.value("id", 0) : 0);
            g_app.Invalidate();
        });
    };
    S.busy = true; S.orderError.clear(); g_app.Invalidate();
    if (S.order.is_object() && S.order.value("id", 0) > 0) {
        Api::Call(L"POST", L"/api/orders/" + std::to_wstring(S.order.value("id", 0)) + L"/items",
                  json{ {"items", CartItemsJson()} }, after, S.createKey);
    } else {
        Api::Call(L"POST", L"/api/orders",
                  json{ {"tableId", S.tableId}, {"items", CartItemsJson()} }, after, S.createKey);
    }
}

/** Poslať do kuchyne/baru — sendKey rotuje LEN po úspechu. */
inline void DoSend() {
    if (S.busy) return;
    SyncCart([](int orderId) {
        if (orderId <= 0) { ShowToast(L"Niet čo poslať", Th::Amber); return; }
        S.busy = true; g_app.Invalidate();
        Api::Call(L"POST", L"/api/orders/" + std::to_wstring(orderId) + L"/send-and-print",
            json{ {"overrideLimit", false} },
            [](ApiResult& r) {
                S.busy = false;
                if (r.ok) {
                    S.sendKey = Api::NewKey(L"send");
                    int qty = 0;
                    if (r.body.is_object())
                        for (auto& it : r.body.value("items", json::array()))
                            qty += it.value("qty", 0);
                    ShowToast(L"Odoslané (" + std::to_wstring(qty) + L" ks)", Th::Sage);
                    Api::Get(L"/api/orders/table/" + std::to_wstring(S.tableId), [](ApiResult& r2) {
                        if (r2.ok && r2.body.is_array() && !r2.body.empty()) S.order = r2.body[0];
                        g_app.Invalidate();
                    });
                } else {
                    S.orderError = r.error.empty() ? L"Odoslanie zlyhalo." : r.error;
                }
                g_app.Invalidate();
            }, S.sendKey);
    });
}

/** Platba — sync + auto-send + pay s 60 s read timeoutom (Portos). */
inline void DoPay() {
    if (S.payBusy) return;
    S.payBusy = true; S.payError.clear(); S.payNote.clear(); g_app.Invalidate();
    SyncCart([](int orderId) {
        if (orderId <= 0) { S.payBusy = false; S.payError = L"Prázdny účet."; g_app.Invalidate(); return; }
        Api::Call(L"POST", L"/api/orders/" + std::to_wstring(orderId) + L"/send-and-print",
            json{ {"overrideLimit", false} },
            [orderId](ApiResult& sr) {
                if (sr.ok) S.sendKey = Api::NewKey(L"send");
                // čerstvá suma po sende
                Api::Get(L"/api/orders/table/" + std::to_wstring(S.tableId), [orderId](ApiResult& fr) {
                    double amount = S.payAmount;
                    if (fr.ok && fr.body.is_array() && !fr.body.empty()) {
                        S.order = fr.body[0];
                        auto& g = S.order["grandTotal"];
                        amount = g.is_number() ? g.get<double>() : atof(g.get<std::string>().c_str());
                        S.payAmount = amount;
                    }
                    Api::Call(L"POST", L"/api/payments",
                        json{ {"orderId", orderId},
                              {"method", ApiDetail::ToUtf8(S.payMethod)},
                              {"amount", amount} },
                        [](ApiResult& r) {
                            S.payBusy = false;
                            if (r.ok) {
                                S.payOpen = false; S.payUnclear = false;
                                ShowToast(L"Zaplatené " + Money(S.payAmount) +
                                          (S.payMethod == L"karta" ? L" (karta)" : L" (hotovosť)"), Th::Sage);
                                S.screen = Screen::Floor;
                                LoadFloor(true);
                            } else if (r.isTimeout ||
                                       (r.status == 409 && r.body.is_object() &&
                                        r.body.value("error", "") == "processing")) {
                                // Server MOŽNO platbu dokončil — NIKDY slepý retry.
                                // Skontrolovať znova drží TEN ISTÝ payKey (replay).
                                S.payUnclear = true;
                                S.payError = L"Stav platby je nejasný — server neodpovedal včas. "
                                             L"NEPOSIELAJ znova naslepo.";
                            } else {
                                S.payError = r.error.empty() ? L"Platba zlyhala." : r.error;
                            }
                            g_app.Invalidate();
                        }, S.payKey, 60000);
                });
            }, S.sendKey);
    });
}

// ============================================================== KRESLENIE ==
inline void DrawToast() {
    if (S.toast.empty() || GetTickCount64() > S.toastUntil) return;
    float w = std::min(520.f, g_app.W - 40), h = 46;
    D2D1_RECT_F r = R((g_app.W - w) / 2, g_app.H - h - 18, w, h);
    g_app.Fill(r, Th::Espresso, Th::RMD);
    g_app.Fill(R(r.left, r.top, 4, h), S.toastColor, 2);
    g_app.Text(R(r.left + 16, r.top, w - 24, h), S.toast, g_app.fBody, Th::Cream);
}

inline void DrawOffline() {
    if (!S.offline) return;
    D2D1_RECT_F r = R(0, 0, g_app.W, 26);
    g_app.Fill(r, Th::Danger);
    g_app.Text(r, L"OFFLINE — server nedostupný, skúšam znova…", g_app.fSmall, Th::Cream,
               DWRITE_TEXT_ALIGNMENT_CENTER);
}

// ------------------------------------------------------------------ Setup --
inline void ConfirmSetup() {
    if (S.urlInput.empty()) return;
    std::wstring url = S.urlInput;
    if (url.rfind(L"http", 0) != 0) url = L"http://" + url;
    Api::SetServer(url);
    HKEY h;
    RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\SurfSpiritPOS", 0, nullptr, 0, KEY_WRITE, nullptr, &h, nullptr);
    RegSetValueExW(h, L"ServerUrl", 0, REG_SZ, (BYTE*)url.c_str(), (DWORD)((url.size() + 1) * 2));
    RegCloseKey(h);
    S.screen = Screen::Login;
    g_app.Invalidate();
}

inline void DrawSetup() {
    g_app.Fill(R(0, 0, g_app.W, g_app.H), Th::Cream);
    float w = std::min(560.f, g_app.W - 48);
    float x = (g_app.W - w) / 2, y = g_app.H * 0.3f;
    g_app.Text(R(x, y - 90, w, 40), L"Surf Spirit POS", g_app.fHero, Th::Espresso);
    g_app.Text(R(x, y - 46, w, 24), L"Adresa servera (IP:port):", g_app.fLabel, Th::EspressoSoft);

    D2D1_RECT_F input = R(x, y - 16, w, 52);
    g_app.Card(input, Th::CreamElev);
    g_app.Text(R(input.left + 14, input.top, w - 28, 52),
               S.urlInput.empty() ? L"192.168.1.235:3080" : S.urlInput,
               g_app.fTitle, S.urlInput.empty() ? Th::EspressoDim : Th::Espresso);

    if (g_app.Button(R(x, y + 52, w, 54), L"Pokračovať", Th::Terra, Th::Cream,
                     g_app.fBodyBold, !S.urlInput.empty()))
        ConfirmSetup();
    g_app.Text(R(x, y + 118, w, 20), L"Píš klávesnicou; Enter potvrdí.", g_app.fSmall, Th::EspressoDim);
}

// ------------------------------------------------------------------ Login --
inline void TryLogin() {
    if (S.pin.size() < 4 || S.loginBusy) return;
    S.loginBusy = true; S.loginError.clear(); g_app.Invalidate();
    Api::Call(L"POST", L"/api/auth/login",
        json{ {"pin", ApiDetail::ToUtf8(S.pin)} },
        [](ApiResult& r) {
            S.loginBusy = false;
            if (r.ok && r.body.is_object()) {
                Api::SetToken(ApiDetail::ToWide(r.body.value("token", "")));
                auto u = r.body.value("user", json::object());
                S.userName = ApiDetail::ToWide(u.value("name", ""));
                S.role = ApiDetail::ToWide(u.value("role", ""));
                S.pin.clear();
                S.screen = Screen::Floor;
                Api::Get(L"/api/zones", [](ApiResult& zr) {
                    if (zr.ok && zr.body.is_array()) S.zones = zr.body;
                    g_app.Invalidate();
                });
                LoadFloor(false);
                LoadMenu();
            } else {
                S.loginError = r.status == 401 ? L"Nesprávny PIN."
                              : (r.error.empty() ? L"Prihlásenie zlyhalo." : r.error);
                S.pin.clear();
            }
            g_app.Invalidate();
        });
}

inline void DrawLogin() {
    g_app.Fill(R(0, 0, g_app.W, g_app.H), Th::Cream);
    float padW = 3 * 92 + 2 * Th::S3;
    float totalW = std::min(g_app.W - 48, padW + 360);
    float x0 = (g_app.W - totalW) / 2;
    float yc = g_app.H / 2;

    // brand blok vľavo
    g_app.Fill(R(x0, yc - 130, 64, 52), Th::Terra, Th::RMD);
    g_app.Text(R(x0, yc - 130, 64, 52), L"SSS", g_app.fTitle, Th::Cream, DWRITE_TEXT_ALIGNMENT_CENTER);
    g_app.Text(R(x0 + 76, yc - 132, 280, 30), L"Surf Spirit POS", g_app.fTitle, Th::Espresso);
    g_app.Text(R(x0 + 76, yc - 102, 280, 22), L"Pokladničný systém", g_app.fLabel, Th::EspressoSoft);
    g_app.Text(R(x0, yc - 52, 320, 24), L"Zadaj PIN pre prihlásenie", g_app.fBody, Th::EspressoSoft);
    if (!S.loginError.empty())
        g_app.TextWrap(R(x0, yc - 16, 320, 60), S.loginError, g_app.fBody, Th::Danger);
    g_app.Text(R(x0, yc + 96, 320, 20), L"F11 okno · Ctrl+, server", g_app.fSmall, Th::EspressoDim);

    // PIN pad vpravo
    float px = x0 + totalW - padW;
    float py = yc - 190;
    // dots
    for (int i = 0; i < 6; i++) {
        float dx = px + padW / 2 - (6 * 22 - 6) / 2 + i * 22;
        g_app.Fill(R(dx, py, 15, 15), (int)S.pin.size() > i ? Th::Terra : Th::CreamSunken, 999);
    }
    const wchar_t* keys[12] = { L"1",L"2",L"3",L"4",L"5",L"6",L"7",L"8",L"9",L"⌫",L"0",L"OK" };
    for (int i = 0; i < 12; i++) {
        int row = i / 3, col = i % 3;
        D2D1_RECT_F kr = R(px + col * (92 + Th::S3), py + 36 + row * (76 + Th::S3), 92, 76);
        bool isOk = i == 11, isBk = i == 9;
        if (isOk) {
            bool en = S.pin.size() >= 4 && !S.loginBusy;
            if (g_app.Button(kr, S.loginBusy ? L"…" : L"OK", en ? Th::Terra : Th::CreamSunken,
                             en ? Th::Cream : Th::EspressoDim, g_app.fTitle, true) && en)
                TryLogin();
        } else if (isBk) {
            if (g_app.GhostButton(kr, L"⌫", Th::EspressoSoft, g_app.fTitle) && !S.pin.empty())
                S.pin.pop_back();
        } else {
            g_app.Card(kr, Th::Cream);
            g_app.Text(kr, keys[i], g_app.fTitle, Th::Espresso, DWRITE_TEXT_ALIGNMENT_CENTER);
            if (g_app.Clicked(kr) && S.pin.size() < 6) S.pin += keys[i];
        }
    }
}

// ------------------------------------------------------------------ Floor --
inline UINT32 StatusColor(const std::string& st) {
    if (st == "occupied") return Th::Terra;
    if (st == "reserved") return Th::Amber;
    if (st == "dirty")    return Th::Danger;
    return Th::Sage;
}

inline void DrawHeader(const std::wstring& title, bool backBtn) {
    D2D1_RECT_F bar = R(0, S.offline ? 26.f : 0.f, g_app.W, 64);
    g_app.Fill(bar, Th::CreamElev);
    g_app.Fill(R(0, bar.bottom, g_app.W, 1), Th::Border, 0, 0.22f);
    float x = Th::S4;
    if (backBtn) {
        if (g_app.GhostButton(R(x, bar.top + 10, 88, 44), L"← Stoly", Th::Espresso, g_app.fLabel)) {
            // odchod zo stola: neodoslané položky sa NESMÚ ticho stratiť
            if (!S.cart.empty()) { ShowToast(L"Najprv pošli alebo zruš položky", Th::Amber); }
            else { S.screen = Screen::Floor; LoadFloor(true); }
        }
        x += 100;
    } else {
        g_app.Fill(R(x, bar.top + 12, 46, 40), Th::Terra, Th::RSM);
        g_app.Text(R(x, bar.top + 12, 46, 40), L"SSS", g_app.fLabel, Th::Cream, DWRITE_TEXT_ALIGNMENT_CENTER);
        x += 58;
    }
    g_app.Text(R(x, bar.top, 420, 64), title, g_app.fTitle, Th::Espresso);

    // čas + user + odhlásiť (vpravo)
    SYSTEMTIME st; GetLocalTime(&st);
    wchar_t clock[16]; swprintf(clock, 16, L"%02d:%02d", st.wHour, st.wMinute);
    float rx = g_app.W - Th::S4;
    if (!backBtn) {
        rx -= 110;
        if (g_app.GhostButton(R(rx, bar.top + 10, 110, 44), L"Odhlásiť", Th::EspressoSoft, g_app.fLabel)) {
            Api::SetToken(L"");
            S = PosState{};
            S.screen = Screen::Login;
        }
        rx -= 12;
    }
    rx -= 150;
    g_app.Text(R(rx, bar.top, 150, 64),
               S.userName + L"  ·  " + clock, g_app.fLabel, Th::EspressoSoft,
               DWRITE_TEXT_ALIGNMENT_TRAILING);
}

inline void DrawFloor() {
    g_app.Fill(R(0, 0, g_app.W, g_app.H), Th::Cream);
    DrawOffline();
    DrawHeader(L"Mapa stolov", false);
    float top = (S.offline ? 26.f : 0.f) + 64 + Th::S3;

    // zóny — pill rad
    std::vector<std::wstring> zoneNames;
    for (auto& z : S.zones) zoneNames.push_back(ApiDetail::ToWide(z.value("slug", "")));
    if (zoneNames.empty()) {
        for (auto& t : S.tables) {
            std::wstring z = ApiDetail::ToWide(t.value("zone", ""));
            if (!z.empty() && std::find(zoneNames.begin(), zoneNames.end(), z) == zoneNames.end())
                zoneNames.push_back(z);
        }
    }
    float zx = Th::S4;
    for (auto& z : zoneNames) {
        float zw = std::max(86.f, 24.f + z.size() * 11.f);
        D2D1_RECT_F zr = R(zx, top, zw, 42);
        bool act = z == S.activeZone;
        g_app.Fill(zr, act ? Th::Terra : Th::CreamElev, 999);
        if (!act) g_app.Stroke(zr, Th::Border, 999, 0.22f);
        g_app.Text(zr, z, g_app.fLabel, act ? Th::Cream : Th::Espresso, DWRITE_TEXT_ALIGNMENT_CENTER);
        if (g_app.Clicked(zr)) { S.activeZone = z; }
        zx += zw + Th::S2;
    }
    top += 42 + Th::S4;

    // grid stolov (zjednodušený — bez x/y plánu; karty 170×110)
    float cw = 176, ch = 112, gap = Th::S3;
    int cols = std::max(1, (int)((g_app.W - Th::S4 * 2 + gap) / (cw + gap)));
    int i = 0;
    for (auto& t : S.tables) {
        if (!S.activeZone.empty() &&
            ApiDetail::ToWide(t.value("zone", "")) != S.activeZone) continue;
        int col = i % cols, row = i / cols;
        D2D1_RECT_F cr = R(Th::S4 + col * (cw + gap), top + row * (ch + gap), cw, ch);
        if (cr.top > g_app.H) break;
        i++;

        int id = t.value("id", 0);
        std::wstring nm = ApiDetail::ToWide(t.value("name", ""));
        std::string  st = t.value("status", "free");
        bool occupied = S.tableTotals.count(id) && S.tableTotals[id] > 0.004;
        UINT32 c = occupied ? Th::Terra : StatusColor(st);

        g_app.Card(cr, Th::CreamElev);
        g_app.Fill(R(cr.left, cr.top, 5, ch), c, 2);
        g_app.Text(R(cr.left + 16, cr.top + 10, cw - 24, 26), nm, g_app.fBodyBold, Th::Espresso);
        if (occupied) {
            g_app.Text(R(cr.left + 16, cr.top + 40, cw - 24, 24),
                       Money(S.tableTotals[id]), g_app.fTitle, Th::Terra);
            int acc = S.tableAccounts[id];
            if (acc > 1)
                g_app.Text(R(cr.left + 16, cr.top + 72, cw - 24, 22),
                           std::to_wstring(acc) + L" účty", g_app.fSmall, Th::EspressoSoft);
        } else {
            g_app.Text(R(cr.left + 16, cr.top + 44, cw - 24, 22), L"voľný", g_app.fLabel, Th::Sage);
        }
        if (g_app.Clicked(cr)) OpenTable(id, nm);
    }
    DrawToast();
}

// ------------------------------------------------------------------ Order --
inline void DrawPayDialog();

inline void DrawOrder() {
    g_app.Fill(R(0, 0, g_app.W, g_app.H), Th::Cream);
    DrawOffline();
    DrawHeader(S.tableName, true);
    float top = (S.offline ? 26.f : 0.f) + 64 + Th::S3;
    float H = g_app.H - top - Th::S3;

    float rightW = std::min(420.f, g_app.W * 0.34f);
    float railW = 168;
    float gridX = Th::S4 + railW + Th::S3;
    float gridW = g_app.W - gridX - rightW - Th::S4 * 2;

    // ---- kategórie ----
    float cy = top;
    for (int ci = 0; ci < (int)S.menu.size(); ci++) {
        D2D1_RECT_F cr = R(Th::S4, cy, railW, 52);
        if (cr.bottom > top + H) break;
        bool act = ci == S.activeCat;
        if (act) g_app.Fill(cr, Th::Terra, Th::RSM, 0.10f);
        if (act) g_app.Fill(R(cr.left, cr.top, 4, 52), Th::Terra, 2);
        g_app.Text(R(cr.left + 14, cr.top, railW - 20, 52),
                   S.menu[ci].icon + L"  " + S.menu[ci].label,
                   act ? g_app.fBodyBold : g_app.fBody,
                   act ? Th::Terra : Th::Espresso);
        if (g_app.Clicked(cr)) S.activeCat = ci;
        cy += 52 + 4;
    }

    // ---- grid produktov ----
    if (S.activeCat < (int)S.menu.size()) {
        auto& items = S.menu[S.activeCat].items;
        float pw = 150, ph = 118, gap = Th::S2;
        int cols = std::max(1, (int)((gridW + gap) / (pw + gap)));
        for (int ii = 0; ii < (int)items.size(); ii++) {
            int col = ii % cols, row = ii / cols;
            D2D1_RECT_F pr = R(gridX + col * (pw + gap), top + row * (ph + gap), pw, ph);
            if (pr.top > top + H) break;
            auto& m = items[ii];
            g_app.Card(pr, Th::Cream);
            g_app.Text(R(pr.left + 12, pr.top + 8, pw - 20, 30), m.emoji, g_app.fTitle, Th::Espresso);
            g_app.TextWrap(R(pr.left + 12, pr.top + 40, pw - 20, 44), m.name, g_app.fLabel, Th::Espresso);
            g_app.Text(R(pr.left + 12, pr.bottom - 30, pw - 20, 24),
                       Money(m.price), g_app.fLabel, Th::Terra);
            // qty badge z košíka
            for (auto& l : S.cart) if (l.menuItemId == m.id) {
                D2D1_RECT_F b = R(pr.right - 34, pr.top + 8, 26, 26);
                g_app.Fill(b, Th::Terra, 999);
                g_app.Text(b, std::to_wstring(l.qty), g_app.fSmall, Th::Cream, DWRITE_TEXT_ALIGNMENT_CENTER);
            }
            if (g_app.Clicked(pr)) AddToCart(m);
        }
    }

    // ---- pravý panel: účet ----
    float rx = g_app.W - rightW - Th::S4;
    D2D1_RECT_F panel = R(rx, top, rightW, H);
    g_app.Fill(panel, Th::CreamSunken, Th::RMD);
    g_app.Fill(R(rx, top, 4, H), Th::Terra, 2);

    float iy = top + Th::S3;
    float rowH = 40;
    // serverové (odoslané aj neodoslané) položky
    if (S.order.is_object()) {
        for (auto& it : S.order.value("items", json::array())) {
            if (iy > top + H - 240) break;
            bool sent = it.value("sent", false);
            std::wstring nm = ApiDetail::ToWide(it.value("name", ""));
            int qty = it.value("qty", 1);
            double price = 0;
            auto& p = it["price"];
            price = p.is_number() ? p.get<double>() : atof(p.get<std::string>().c_str());
            g_app.Text(R(rx + 16, iy, rightW - 130, rowH),
                       std::to_wstring(qty) + L"× " + nm, g_app.fBody,
                       sent ? Th::Sage : Th::Espresso);
            g_app.Text(R(rx + rightW - 110, iy, 94, rowH), Money(price * qty),
                       g_app.fBody, Th::Espresso, DWRITE_TEXT_ALIGNMENT_TRAILING);
            iy += rowH;
        }
    }
    // lokálny košík (+/− X)
    for (int li = 0; li < (int)S.cart.size(); li++) {
        if (iy > top + H - 240) break;
        auto& l = S.cart[li];
        g_app.Text(R(rx + 16, iy, rightW - 230, rowH), l.name, g_app.fBodyBold, Th::Espresso);
        D2D1_RECT_F minus = R(rx + rightW - 214, iy + 2, 36, 36);
        D2D1_RECT_F plus  = R(rx + rightW - 130, iy + 2, 36, 36);
        D2D1_RECT_F del   = R(rx + rightW - 56,  iy + 2, 36, 36);
        if (g_app.GhostButton(minus, L"−", Th::Terra, g_app.fBodyBold)) {
            if (--l.qty <= 0) S.cart.erase(S.cart.begin() + li);
            S.createKey = Api::NewKey(L"create");
        }
        g_app.Text(R(rx + rightW - 174, iy, 40, 40), std::to_wstring(l.qty),
                   g_app.fBodyBold, Th::Terra, DWRITE_TEXT_ALIGNMENT_CENTER);
        if (g_app.GhostButton(plus, L"+", Th::Terra, g_app.fBodyBold)) {
            l.qty++; S.createKey = Api::NewKey(L"create");
        }
        if (g_app.GhostButton(del, L"✕", Th::Danger, g_app.fBodyBold)) {
            S.cart.erase(S.cart.begin() + li);
            S.createKey = Api::NewKey(L"create");
        }
        iy += rowH + 4;
    }
    if (!S.order.is_object() && S.cart.empty())
        g_app.Text(R(rx + 16, iy, rightW - 32, 40), L"Ťukni na produkt vľavo…",
                   g_app.fBody, Th::EspressoDim);

    // CELKOM hero + akcie (dole)
    float by = top + H - 196;
    if (!S.orderError.empty())
        g_app.TextWrap(R(rx + 14, by - 44, rightW - 28, 40), S.orderError, g_app.fSmall, Th::Danger);

    D2D1_RECT_F hero = R(rx + 12, by, rightW - 24, 72);
    g_app.Fill(hero, Th::Terra, Th::RMD);
    g_app.Fill(R(hero.left, hero.top, rightW - 24, 36), Th::TerraLight, Th::RMD, 0.35f);
    g_app.Text(R(hero.left + 16, hero.top + 8, 200, 20), L"CELKOM", g_app.fSmall, Th::Cream, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR, 0.85f);
    g_app.Text(R(hero.left + 16, hero.top + 22, rightW - 56, 46), Money(OrderTotal()),
               g_app.fHero, Th::Cream);

    bool canSend = !S.cart.empty() ||
        [&]{ if (!S.order.is_object()) return false;
             for (auto& it : S.order.value("items", json::array()))
                 if (!it.value("sent", false)) return true;
             return false; }();
    if (g_app.Button(R(rx + 12, by + 84, rightW - 24, 50),
                     S.busy ? L"Odosielam…" : L"Poslať objednávku",
                     Th::Amber, Th::Espresso, g_app.fBodyBold, canSend && !S.busy))
        DoSend();
    if (g_app.Button(R(rx + 12, by + 142, rightW - 24, 50), L"Platba",
                     Th::Terra, Th::Cream, g_app.fBodyBold,
                     (OrderTotal() > 0.004) && !S.busy)) {
        S.payOpen = true;
        S.payKey = Api::NewKey(L"pay");
        S.payGiven.clear(); S.payError.clear(); S.payUnclear = false;
        S.payAmount = OrderTotal();
    }

    if (S.payOpen) DrawPayDialog();
    DrawToast();
}

// ---------------------------------------------------------------- Payment --
inline void DrawPayDialog() {
    g_app.Fill(R(0, 0, g_app.W, g_app.H), Th::Espresso, 0, 0.55f);   // scrim
    float w = std::min(460.f, g_app.W - 40), h = 430;
    float x = (g_app.W - w) / 2, y = (g_app.H - h) / 2;
    D2D1_RECT_F dlg = R(x, y, w, h);
    g_app.Fill(dlg, Th::Cream, Th::RLG);

    g_app.Text(R(x + 24, y + 16, w - 48, 30), L"Platba", g_app.fTitle, Th::Espresso);

    // K ÚHRADE
    D2D1_RECT_F hero = R(x + 24, y + 54, w - 48, 64);
    g_app.Fill(hero, Th::Terra, Th::RMD, 0.08f);
    g_app.Stroke(hero, Th::Terra, Th::RMD, 0.35f);
    g_app.Text(R(hero.left + 14, hero.top + 6, 200, 18), L"K ÚHRADE", g_app.fSmall, Th::TerraDim,
               DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
    g_app.Text(R(hero.left + 14, hero.top + 18, w - 76, 44), Money(S.payAmount),
               g_app.fHero, Th::Terra);

    // metóda
    float half = (w - 48 - Th::S2) / 2;
    bool cash = S.payMethod == L"hotovost";
    if (g_app.Button(R(x + 24, y + 132, half, 50), L"Hotovosť",
                     cash ? Th::Terra : Th::CreamElev, cash ? Th::Cream : Th::Espresso))
        S.payMethod = L"hotovost";
    if (g_app.Button(R(x + 24 + half + Th::S2, y + 132, half, 50), L"Karta",
                     !cash ? Th::Terra : Th::CreamElev, !cash ? Th::Cream : Th::Espresso))
        S.payMethod = L"karta";

    // hotovosť: dostal som / vydavok
    float gy = y + 196;
    if (cash) {
        g_app.Text(R(x + 24, gy, 160, 24), L"Dostal som:", g_app.fLabel, Th::EspressoSoft,
                   DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        D2D1_RECT_F in = R(x + 24, gy + 24, w - 48, 44);
        g_app.Card(in, Th::CreamElev);
        g_app.Text(R(in.left + 12, in.top, w - 72, 44),
                   S.payGiven.empty() ? L"presná suma" : S.payGiven + L" €",
                   g_app.fBodyBold, S.payGiven.empty() ? Th::EspressoDim : Th::Espresso);
        double given = _wtof([&]{ std::wstring g2 = S.payGiven;
                                  for (auto& ch : g2) if (ch == L',') ch = L'.';
                                  return g2; }().c_str());
        if (!S.payGiven.empty()) {
            double change = given - S.payAmount;
            g_app.Text(R(x + 24, gy + 74, w - 48, 24),
                       change >= 0 ? L"Vydať: " + Money(change) : L"CHÝBA: " + Money(-change),
                       g_app.fBodyBold, change >= 0 ? Th::Sage : Th::Danger,
                       DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        }
    }

    if (!S.payError.empty())
        g_app.TextWrap(R(x + 24, y + h - 168, w - 48, 56), S.payError, g_app.fSmall, Th::Danger);

    if (S.payUnclear) {
        if (g_app.GhostButton(R(x + 24, y + h - 110, w - 48, 44),
                              L"Skontrolovať znova (bezpečné)", Th::Navy, g_app.fLabel))
            DoPay();   // TEN ISTÝ payKey -> server replay, nikdy 2. doklad
    }

    if (g_app.Button(R(x + 24, y + h - 60, (w - 48) * 0.62f, 48),
                     S.payBusy ? L"Spracovávam…" : L"Zaplatiť " + Money(S.payAmount),
                     Th::Terra, Th::Cream, g_app.fBodyBold, !S.payBusy))
        DoPay();
    if (g_app.GhostButton(R(x + 24 + (w - 48) * 0.62f + Th::S2, y + h - 60,
                            (w - 48) * 0.38f - Th::S2, 48), L"Zrušiť",
                          Th::Espresso, g_app.fLabel, !S.payBusy))
        S.payOpen = false;
}

// ----------------------------------------------------------------- router --
inline void DrawFrame() {
    switch (S.screen) {
    case Screen::Setup: DrawSetup(); break;
    case Screen::Login: DrawLogin(); break;
    case Screen::Floor: DrawFloor(); break;
    case Screen::Order: DrawOrder(); break;
    }
}

inline void HandleKey(UINT vk) {
    if (S.screen == Screen::Login) {
        if (vk >= '0' && vk <= '9' && S.pin.size() < 6) { S.pin += (wchar_t)vk; g_app.Invalidate(); }
        else if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9 && S.pin.size() < 6) { S.pin += (wchar_t)('0' + vk - VK_NUMPAD0); g_app.Invalidate(); }
        else if (vk == VK_BACK && !S.pin.empty()) { S.pin.pop_back(); g_app.Invalidate(); }
        else if (vk == VK_RETURN) TryLogin();
    } else if (S.screen == Screen::Setup) {
        if (vk == VK_BACK && !S.urlInput.empty()) { S.urlInput.pop_back(); g_app.Invalidate(); }
        else if (vk == VK_RETURN) ConfirmSetup();
    } else if (S.payOpen && S.payMethod == L"hotovost") {
        if (vk >= '0' && vk <= '9' && S.payGiven.size() < 8) { S.payGiven += (wchar_t)vk; g_app.Invalidate(); }
        else if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9 && S.payGiven.size() < 8) { S.payGiven += (wchar_t)('0' + vk - VK_NUMPAD0); g_app.Invalidate(); }
        else if ((vk == VK_OEM_COMMA || vk == VK_DECIMAL) && S.payGiven.find(L',') == std::wstring::npos && !S.payGiven.empty()) { S.payGiven += L','; g_app.Invalidate(); }
        else if (vk == VK_BACK && !S.payGiven.empty()) { S.payGiven.pop_back(); g_app.Invalidate(); }
        else if (vk == VK_ESCAPE && !S.payBusy) { S.payOpen = false; g_app.Invalidate(); }
    }
}

inline void HandleChar(wchar_t ch) {
    if (S.screen == Screen::Setup) {
        if (ch >= 32 && ch < 127 && S.urlInput.size() < 64) { S.urlInput += ch; g_app.Invalidate(); }
    }
}
