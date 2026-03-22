@echo off
echo ==============================================
echo Uruchamianie Systemu AI (GIGABET)
echo ==============================================
echo Z modeli AI zostały wygenerowane nowe wagi. Uruchamiam procesy...

echo.
echo 1. Startowanie AI Service API (Port 8000)...
start "AI Service" cmd /k "cd /d d:\tradingmaches\ai_betting_system\ai-service && python main.py"

echo.
echo 2. Startowanie Data Service (Pobieranie Kursów)...
start "Data Service" cmd /k "cd /d d:\tradingmaches\ai_betting_system\data-service && npm install && node index.js"

echo.
echo 3. Startowanie Analysis Service (Discord Bot)...
start "Analysis & Discord Service" cmd /k "cd /d d:\tradingmaches\ai_betting_system\analysis-service && npm install && node index.js"

echo ==============================================
echo Gotowe! Otworzyly sie 3 nowe konsole. 
echo Pamiętaj, że do Node.js musisz mieć działającą bazę PostgreSQL (db).
echo ==============================================
