@echo off
rem Folder Explorer - canli gelistirme: kodu degistirdikce uygulama kendiliginden yenilenir.
rem Kurulum gerekmez. Kapatmak icin bu pencerede Ctrl+C.
cd /d "%~dp0"
if defined DENEME (echo [deneme] klasor: %CD% & exit /b 0)

echo Calisan Folder Explorer varsa duzgunce kapatiliyor...
if exist "src-tauri\target\debug\folder-explorer.exe" "src-tauri\target\debug\folder-explorer.exe" --quit
if exist "src-tauri\target\release\folder-explorer.exe" "src-tauri\target\release\folder-explorer.exe" --quit

rem onceki gelistirme sunucusu 1420 portunu tutuyorsa bosalt
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":1420 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1

echo Gelistirme modu basliyor. Ilk acilista derleme 1-2 dakika surebilir...
call npm run tauri dev
