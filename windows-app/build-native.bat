@echo off
REM ============================================================
REM Surf Spirit POS — NATIVNA kasa (Direct2D, bez webu)
REM Vystup: build\SurfSpiritPOS-Native.exe
REM ============================================================
setlocal

set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
    echo CHYBA: vswhere.exe nenajdene - nainstaluj Visual Studio Build Tools.
    exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
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
cl /nologo /std:c++17 /utf-8 /EHsc /O2 /W3 /DUNICODE /D_UNICODE /DNOMINMAX ^
   native\main.cpp /Fobuild\native-main.obj /c || exit /b 1

echo [3/3] Link...
link /nologo /SUBSYSTEM:WINDOWS /OUT:build\SurfSpiritPOS-Native.exe ^
     build\native-main.obj build\app.res ^
     user32.lib gdi32.lib ole32.lib shell32.lib advapi32.lib || exit /b 1

echo.
echo OK: build\SurfSpiritPOS-Native.exe
dir build\SurfSpiritPOS-Native.exe | findstr Native
endlocal
