@echo off
rem Folder Explorer - canli gelistirme: kodu degistirdikce uygulama kendiliginden yenilenir.
rem Kurulum gerekmez. Kapatmak icin bu pencerede Ctrl+C.
cd /d "%~dp0"
if defined DENEME (echo [deneme] klasor: %CD% & exit /b 0)

echo Calisan Folder Explorer varsa duzgunce kapatiliyor...
if exist "src-tauri\target\debug\folder-explorer.exe" "src-tauri\target\debug\folder-explorer.exe" --quit
if exist "src-tauri\target\release\folder-explorer.exe" "src-tauri\target\release\folder-explorer.exe" --quit

rem onceki gelistirme sunucusu 1420 portunu tutuyorsa bosalt: yalnizca bu klasorden calisan bir program
rem (bu projenin Vite'i) kapatilir, baska bir program tutuyorsa ona dokunulmaz
set "FE_DIR=%~dp0"
powershell -NoProfile -Command "$busy = 0; foreach ($id in @(Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $p) { continue }; if (('' + $p.ExecutablePath + ' ' + $p.CommandLine).ToLower().Contains($env:FE_DIR.ToLower())) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } else { $busy = 1; Write-Host ('1420 portunu baska bir program kullaniyor: ' + $p.Name + ', PID ' + $id) } }; exit $busy"
if errorlevel 1 (
    echo Folder Explorer baslatilamadi. O programi kapatip calistir.bat dosyasini yeniden acin.
    pause
    exit /b 1
)

echo Gelistirme modu basliyor. Ilk acilista derleme 1-2 dakika surebilir...
call npm run tauri dev
