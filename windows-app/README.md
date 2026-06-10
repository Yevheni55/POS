# Surf Spirit POS — Windows aplikácia

Natívna Windows kasa (Win32 C++ + WebView2). Tenký shell nad webovou kasou,
ktorú servuje POS server — rovnaká filozofia ako Android appka: server je
zdroj pravdy, shell pridáva kiosk správanie.

## Funkcie

- **Kiosk fullscreen** od štartu, `F11` prepína okno/fullscreen
- **Single instance** — druhé spustenie len aktivuje bežiace okno
- **Nastavenia** (`Ctrl+,`): adresa servera + spustenie pri štarte Windows
  (uložené v `HKCU\Software\SurfSpiritPOS`)
- **Retry obrazovka** pri nedostupnom serveri, auto-reconnect každých 5 s
- **Žiadne popupy** — odkazy na cudzie domény idú do systémového prehliadača
- `F5` znovunačítanie, `Ctrl+Q` ukončenie (s potvrdením, Alt+F4 tiež pýta)
- Vypnuté kontextové menu a pinch-zoom (mokré prsty na dotykovej kase)

## Build

Vyžaduje Visual Studio Build Tools 2022 (C++ workload). WebView2 SDK
(hlavičky + `WebView2LoaderStatic.lib`) je vendorované v `sdk/`.

```bat
build.bat        # -> build\SurfSpiritPOS.exe (jedna .exe, žiadne DLL)
```

## Beh

Cieľový stroj potrebuje **WebView2 Runtime** — Windows 11 ho má vstavaný,
na Windows 10 nainštaluj „Microsoft Edge WebView2 Runtime (Evergreen)".

Pri prvom spustení sa appka spýta na adresu servera
(napr. `192.168.1.235:3080`). Profil prehliadača žije v
`%LOCALAPPDATA%\SurfSpiritPOS`.
