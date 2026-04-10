@echo off
TITLE TrendRadar Server

echo Checking dependencies...
IF NOT EXIST "node_modules\" (
    echo [Info] node_modules not found. Installing dependencies...
    npm install
    IF %ERRORLEVEL% NEQ 0 (
        echo [Error] Failed to install dependencies.
        pause
        exit /b %ERRORLEVEL%
    )
    echo [Info] Dependencies installed successfully.
) ELSE (
    echo [Info] Dependencies found.
)

echo.
echo Starting TrendRadar Server...
npm start

pause
