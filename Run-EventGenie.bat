@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 22 or newer is required. Install it from https://nodejs.org/
    pause
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Reinstall Node.js with npm included.
    pause
    exit /b 1
)

if not exist "node_modules\express\package.json" (
    echo Installing EventGenie dependencies...
    call npm ci
    if errorlevel 1 (
        echo Dependency installation failed. If npm blocked the SQLite native build, run:
        echo npm install-scripts approve better-sqlite3
        pause
        exit /b 1
    )
)

if not exist ".env" copy ".env.example" ".env" >nul
set "PORT=8000"
netstat -ano | findstr /C:":8000 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 set "PORT=8181"
echo Starting EventGenie at http://127.0.0.1:%PORT%
echo Keep this window open while using the app. Press Ctrl+C to stop the server.
start "" "http://127.0.0.1:%PORT%"
call npm start

endlocal
