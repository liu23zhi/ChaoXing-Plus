@echo off
setlocal
set "CXPLUS_ROOT=%~dp0."
set "CXPLUS_EXE=%~dp0chaoxing_plus.exe"
if exist "%~dp0..\native-source\build.ps1" (
  set "CXPLUS_ROOT=%~dp0..\.."
  set "CXPLUS_EXE=%~dp0..\native-build\bin\chaoxing_plus.exe"
)
for %%d in ("%CXPLUS_ROOT%") do set "CXPLUS_ROOT=%%~fd"
cd /d "%CXPLUS_ROOT%" || exit /b 1
rem Native silent entry: stage a temporary copy before running; no panel/dialog/console/log;
rem Ctrl+Alt+Shift+S releases one question;
rem Ctrl+Alt+Shift+E or F8 / fullscreen exit / CXExam exit destroys program traces;
rem CXExam files are never deleted. Release layout removes program traces; build layout only removes this EXE.
rem Node fallback: start-windows-node-silent.cmd
if not exist "%CXPLUS_EXE%" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] The previous silent run may have deleted it.& echo [windows] Build it with: npm run build:native& if /i not "%CXPLUS_NO_PAUSE%"=="1" pause& exit /b 9009)
echo [windows] Silent mode: scanning for CXExam.exe; no panel or console will appear.
echo [windows] If the client requires administrator rights, Windows will ask for UAC.
start "" "%CXPLUS_EXE%" --silent-scenario --scan-mode fallback-all --client-first --execution-mode memory --no-disk-write --no-log --quiet --no-panel --answer-mode manual --answer-key Ctrl+Alt+Shift+S --answer-threads 1 --hide-answer-dialog %* --stage-boot
rem Keep this window open after the launcher finishes (set CXPLUS_NO_PAUSE=1 to skip).
if /i not "%CXPLUS_NO_PAUSE%"=="1" pause
exit /b 0

