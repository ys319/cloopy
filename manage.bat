@echo off
setlocal

where deno >nul 2>nul
if %errorlevel% equ 0 (
    for /f "delims=" %%i in ('where deno') do set "DENO=%%i"
) else (
    set "DENO=%~dp0.deno\bin\deno.exe"
)

if not exist "%DENO%" (
    echo [cloopy] Installing Deno locally...
    set "DENO_DIR=%~dp0.deno"
    set "DENO_ZIP=%TEMP%\deno-latest.zip"

    if "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
        set "DENO_URL=https://github.com/denoland/deno/releases/latest/download/deno-aarch64-pc-windows-msvc.zip"
    ) else (
        set "DENO_URL=https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
    )

    powershell -Command "Invoke-WebRequest -Uri '%DENO_URL%' -OutFile '%DENO_ZIP%'"
    if not exist "%~dp0.deno\bin" mkdir "%~dp0.deno\bin"
    powershell -Command "Expand-Archive -Force -Path '%DENO_ZIP%' -DestinationPath '%~dp0.deno\bin'"
    del "%DENO_ZIP%" 2>nul

    if not exist "%DENO%" (
        echo [cloopy] ERROR: Deno installation failed
        pause
        exit /b 1
    )
)

"%DENO%" run --allow-all "%~dp0cli\main.ts" %*
@pause
