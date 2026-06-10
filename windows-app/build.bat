@echo off
REM ============================================================
REM Surf Spirit POS — Windows build (MSVC x64)
REM Vystup: build\SurfSpiritPOS.exe (staticky CRT, bez extra DLL)
REM ============================================================
setlocal

set VSWHERE="%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist %VSWHERE% (
    echo CHYBA: vswhere.exe nenajdene - nainstaluj Visual Studio Build Tools.
    exit /b 1
)
for /f "usebackq tokens=*" %%i in (`%VSWHERE% -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSDIR=%%i
if "%VSDIR%"=="" (
    echo CHYBA: MSVC C++ toolchain nenajdeny.
    exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul

cd /d "%~dp0"
if not exist build mkdir build

echo [1/3] Resources...
rc /nologo /fo build\app.res src\app.rc || exit /b 1

echo [2/3] Compile...
cl /nologo /std:c++17 /utf-8 /EHsc /O2 /W3 /DUNICODE /D_UNICODE ^
   /Isdk src\main.cpp /Fobuild\main.obj /c || exit /b 1

echo [3/3] Link...
link /nologo /SUBSYSTEM:WINDOWS /OUT:build\SurfSpiritPOS.exe ^
     build\main.obj build\app.res sdk\WebView2LoaderStatic.lib ^
     user32.lib gdi32.lib ole32.lib shell32.lib advapi32.lib shlwapi.lib version.lib || exit /b 1

echo.
echo OK: build\SurfSpiritPOS.exe
dir build\SurfSpiritPOS.exe | findstr SurfSpiritPOS
endlocal
