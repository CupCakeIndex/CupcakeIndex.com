@echo off
rem Opens the site on this PC (http://localhost:8000). Close this window to stop.
cd /d "%~dp0docs"
start "" http://localhost:8000
python -m http.server 8000
