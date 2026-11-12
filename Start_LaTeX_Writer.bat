@echo off
cd /d "%~dp0"

echo Starting LaTeX Writer...
echo.

npm start

if errorlevel 1 (
    echo.
    echo LaTeX Writer stopped with an error.
    pause
)