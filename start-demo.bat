@echo off
setlocal EnableExtensions
title GuardSaaB - Judge Demo Launcher

set "PROJECT=%~dp0"
set "ENGINE_URL=http://127.0.0.1:9000/health"
set "COMPANY_URL=http://127.0.0.1:5173/"
set "GUARDSAAB_URL=http://127.0.0.1:5174/"

echo.
echo ================================================================
echo             GUARDSAAB  ^|  NORTHSTAR WORKS
echo                    Presentation launcher
echo ================================================================
echo.

if not exist "%PROJECT%\package.json" (
  echo [ERROR] The application folder was not found:
  echo         %PROJECT%
  goto :fail
)

cd /d "%PROJECT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required. Install Node.js, then run this file again.
  goto :fail
)
node -e "const v=Number(process.versions.node.split('.')[0]);if(v<20)process.exit(1)"
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required. Current version:
  node --version
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm included.
  goto :fail
)

if not exist "credentials.txt" (
  if exist "credentials.example.txt" (
    echo [INFO] credentials.txt was missing. Creating from credentials.example.txt...
    copy "credentials.example.txt" "credentials.txt" >nul
  ) else (
    echo [ERROR] credentials.txt is missing. Restore the private local account file before presenting.
    echo         It is intentionally excluded from Git and contains the seven sign-in accounts.
    goto :fail
  )
)

echo [1/5] Checking project dependencies...
if not exist "node_modules\tsx\dist\cli.mjs" (
  echo       Installing engine dependencies. This may take a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Engine dependency installation failed.
    goto :fail
  )
)
if not exist "dashboard\node_modules\vite\bin\vite.js" (
  echo       Installing website dependencies. This may take a few minutes the first time...
  call npm --prefix dashboard install
  if errorlevel 1 (
    echo [ERROR] Website dependency installation failed.
    goto :fail
  )
)

echo.
echo.
echo [2/5] Checking PostgreSQL database container...
set "USE_LOCAL_DB=1"
where docker >nul 2>nul
if errorlevel 1 (
  echo [WARN] Docker not installed or not in PATH.
  echo        Proceeding in Standalone Mode (in-memory state ^& local file ledger).
  set "USE_LOCAL_DB=0"
) else (
  docker info >nul 2>nul
  if errorlevel 1 (
    echo [WARN] Docker Desktop is not running.
    echo        Proceeding in Standalone Mode (in-memory state ^& local file ledger).
    set "USE_LOCAL_DB=0"
  ) else (
    docker compose up -d --wait postgres >nul 2>nul
    if errorlevel 1 (
      echo [WARN] PostgreSQL container failed to start. Falling back to Standalone Mode.
      set "USE_LOCAL_DB=0"
    ) else (
      echo       PostgreSQL container is ready on 127.0.0.1:54329.
      set "USE_LOCAL_DB=1"
    )
  )
)

echo.
echo [3/5] Starting the GuardSaaB engine...
call :engine_ready
if not errorlevel 1 (
  echo       Existing engine is healthy; reusing it.
) else (
  if "%USE_LOCAL_DB%"=="1" (
    start "GuardSaaB Engine - keep this window open" /D "%PROJECT%" cmd /k "npm run engine:local"
  ) else (
    start "GuardSaaB Engine - keep this window open" /D "%PROJECT%" cmd /k "npm run engine"
  )
  echo       Waiting for the engine health check on :9000...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(60); do { try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:9000/health' -TimeoutSec 2; if ($r.ready -eq $true) { exit 0 } } catch {}; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $end); exit 1"
  if errorlevel 1 (
    echo [ERROR] The engine did not become healthy on port 9000.
    echo         Run 'npm run doctor' to diagnose port conflicts or startup issues.
    goto :fail
  )
  echo       Engine is healthy and operational.
)

echo.
echo [4/5] Starting the two websites...
call :company_ready
if errorlevel 1 (
  start "Northstar Works - keep this window open" /D "%PROJECT%" cmd /k "npm run dev:company"
  echo       Waiting for Northstar Works on port 5173...
  call :wait_company
  if errorlevel 1 (
    echo [ERROR] Northstar Works did not start on port 5173.
    echo         Check its terminal window for startup errors or a port conflict.
    goto :fail
  )
) else (
  echo       Existing Northstar Works site is responding; reusing it.
)

call :guardsaab_ready
if errorlevel 1 (
  start "GuardSaaB Console - keep this window open" /D "%PROJECT%" cmd /k "npm run dev:guardsaab"
  echo       Waiting for GuardSaaB Console on port 5174...
  call :wait_guardsaab
  if errorlevel 1 (
    echo [ERROR] GuardSaaB Console did not start on port 5174.
    echo         Check its terminal window for startup errors or a port conflict.
    goto :fail
  )
) else (
  echo       Existing GuardSaaB Console is responding; reusing it.
)

echo.
echo [5/5] Checking local AI availability...
set "OLLAMA_READY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $t=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; if (@($t.models).Count -gt 0) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  set "OLLAMA_READY=1"
  echo       Ollama is online with at least one local model.
) else (
  where ollama >nul 2>nul
  if not errorlevel 1 (
    echo       Starting Ollama in the background...
    start "Ollama local model service" /min cmd /c "ollama serve"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(20); do { try { $t=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; if (@($t.models).Count -gt 0) { exit 0 } } catch {}; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $end); exit 1" >nul 2>nul
    if not errorlevel 1 (
      set "OLLAMA_READY=1"
      echo       Ollama is online with a local model.
    ) else (
      echo [NOTE] Ollama started, but no local model is ready yet. Zeo will show its offline fallback.
      echo        Download a model before presenting if you want local LLM responses.
    )
  ) else (
    echo [NOTE] Ollama is not installed or has no model available. Websites still start;
    echo        Zeo will show its offline fallback until Ollama and a model are available.
  )
)

echo.
echo ================================================================
echo  READY FOR PRESENTATION
echo.
echo  Northstar Works company website:  %COMPANY_URL%
echo  GuardSaaB governance console:     %GUARDSAAB_URL%
echo  Engine health:                   %ENGINE_URL%
echo.
echo  Sign-in accounts are in the private credentials.txt file.
echo  Keep the three service windows open while presenting.
echo  Close this launcher window when you are done; stop services with Ctrl+C
echo  in their windows. PostgreSQL data remains saved in Docker.
echo ================================================================
echo.
start "" "%COMPANY_URL%"
start "" "%GUARDSAAB_URL%"
echo This window can stay open as your presentation control panel.
pause >nul
exit /b 0

:engine_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:9000/health' -TimeoutSec 2; if ($r.ready -eq $true -and $r.auditStorage -eq 'connected') { exit 0 } } catch {}; exit 1" >nul 2>nul
exit /b %errorlevel%

:company_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
exit /b %errorlevel%

:guardsaab_ready
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:5174/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
exit /b %errorlevel%

:wait_company
powershell -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(45); do { try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $end); exit 1"
exit /b %errorlevel%

:wait_guardsaab
powershell -NoProfile -ExecutionPolicy Bypass -Command "$end=(Get-Date).AddSeconds(45); do { try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:5174/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $end); exit 1"
exit /b %errorlevel%

:fail
echo.
echo Startup stopped. Fix the message above and run start-demo.bat again.
echo.
pause
exit /b 1
