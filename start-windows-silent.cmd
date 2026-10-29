@echo off
setlocal
cd /d "%~dp0" || exit /b 1
rem Native silent entry: no panel/dialog/console/log; Ctrl+Alt+Shift+S releases one question;
rem Ctrl+Alt+Shift+E or F8 / fullscreen exit / CXExam exit destroys program traces;
rem CXExam files are never deleted; deletion needs SHA256SUMS.txt next to the EXE.
rem Node fallback: start-windows-node-silent.cmd
if not exist "%~dp0chaoxing_plus.exe" (echo [windows] chaoxing_plus.exe is missing next to this launcher.& echo [windows] Build it with: bash build-windows.sh& exit /b 9009)
start "" "%~dp0chaoxing_plus.exe" --silent-scenario --scan-mode fallback-all --client-first --execution-mode memory --no-disk-write --no-log --quiet --no-panel --answer-mode manual --answer-key Ctrl+Alt+Shift+S --answer-threads 1 --hide-answer-dialog
exit /b 0
